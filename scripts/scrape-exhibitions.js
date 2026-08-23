require("dotenv").config();
const axios = require("axios");
const cheerio = require("cheerio");
const db = require("../database/database");

const MILSET_URL = "https://milset.org/events";

function toISO(dateStr) {
    if (!dateStr) return null;
    const d = new Date(dateStr);
    if (isNaN(d)) return null;
    return d.toISOString().split("T")[0];
}

function parseDateRange(text) {
    const parts = text.split("-").map((s) => s.trim());
    const start = toISO(parts[0]);
    const end = parts[1] ? toISO(parts[1]) : start;
    return { start, end };
}

const ALL_LABELS = [
    "Event dates:",
    "Register deadline:",
    "Organizer:",
    "Location:",
    "Type:",
    "Scope:",
    "Contact:"
];

function extractField(blockText, label) {
    const idx = blockText.indexOf(label);
    if (idx === -1) return null;

    const after = blockText.slice(idx + label.length);

    // Find whichever other label appears soonest after this one —
    // that marks the end of this field's value.
    let endIdx = after.length;
    for (const other of ALL_LABELS) {
        if (other === label) continue;
        const otherIdx = after.indexOf(other);
        if (otherIdx !== -1 && otherIdx < endIdx) {
            endIdx = otherIdx;
        }
    }

    return after.slice(0, endIdx).trim();
}

async function scrapeExhibitions() {

    console.log("🔎 Fetching MILSET events page...");

    const { data: html } = await axios.get(MILSET_URL, {
        headers: { "User-Agent": "Mozilla/5.0 (InventHub exhibition sync)" }
    });

    console.log(`📄 Fetched ${html.length} characters of HTML`);
    console.log(
        `🔍 Page mentions "Event dates:" → ${html.includes("Event dates:")}`
    );

    const $ = cheerio.load(html);
    const events = [];

    // Instead of assuming specific heading tags (h2/h3/h4), find any
    // element whose text contains both "Event dates:" and "Register
    // deadline:" — then keep only the smallest (leaf-most) matches,
    // since a matching element's ancestors will also match (text
    // bubbles up). This works regardless of what tags MILSET uses.
    const candidates = [];

    $("*").each((i, el) => {
        const $el = $(el);
        const text = $el.text();
        if (
            text.includes("Event dates:") &&
            text.includes("Register deadline:")
        ) {
            candidates.push(el);
        }
    });

    console.log(`🧩 Found ${candidates.length} candidate elements`);

    const cards = candidates.filter((el) => {
        // Keep only elements with no matching descendant —
        // i.e. the innermost (smallest) container that still matches.
        const hasMatchingChild = candidates.some(
            (other) => other !== el && $.contains(el, other)
        );
        return !hasMatchingChild;
    });

    console.log(`🎴 Narrowed down to ${cards.length} event cards`);

    function isLabelText(text) {
        return ALL_LABELS.some(
            (label) => text === label || text.startsWith(label)
        );
    }

    function findTitle($card) {
        let $scope = $card;

        for (let level = 0; level < 4; level++) {
            const headings = $scope.find("h1,h2,h3,h4,h5,h6").toArray();

            for (const h of headings) {
                const text = $(h).text().trim();
                if (text && text.length > 3 && !isLabelText(text)) {
                    return text;
                }
            }

            $scope = $scope.parent();
            if (!$scope.length) break;
        }

        return null;
    }

    cards.forEach((cardEl) => {

        const $card = $(cardEl);
        const title = findTitle($card);

        if (!title) return;

        const blockText = $card.text().replace(/\s+/g, " ").trim();

        const eventDatesRaw = extractField(blockText, "Event dates:");
        const deadlineRaw = extractField(blockText, "Register deadline:");
        const organizer = extractField(blockText, "Organizer:");
        const location = extractField(blockText, "Location:");
        const type = extractField(blockText, "Type:");
        const scope = extractField(blockText, "Scope:");
        const contact = extractField(blockText, "Contact:");
        const contactEmail = contact ? contact.split(/\s+/)[0] : null;

        if (!eventDatesRaw) return;

        const { start, end } = parseDateRange(eventDatesRaw);
        const registrationDeadline = deadlineRaw ? toISO(deadlineRaw) : null;

        function findLinks($startEl) {
            let website = null;
            let registrationUrl = null;
            let $scope = $startEl;

            for (let level = 0; level < 4; level++) {

                $scope.find("a").each((j, a) => {
                    const linkText = $(a).text().trim().toLowerCase();
                    const href = $(a).attr("href");
                    if (!href) return;
                    if (linkText.includes("website") && !website) {
                        website = href;
                    }
                    if (linkText.includes("register") && !registrationUrl) {
                        registrationUrl = href;
                    }
                });

                if (website || registrationUrl) break;

                $scope = $scope.parent();
                if (!$scope.length) break;
            }

            return { website, registrationUrl };
        }

        const { website, registrationUrl } = findLinks($card);

        let country = null;
        let city = null;

        if (location && location.includes(",")) {
            const parts = location.split(",").map((s) => s.trim());
            city = parts[0];
            country = parts[parts.length - 1];
        } else if (location) {
            country = location;
        }

        events.push({
            title,
            country,
            city,
            startDate: start,
            endDate: end,
            registrationDeadline,
            category: type,
            scope,
            organizer,
            website,
            registrationUrl,
            source: "MILSET",
            dates: eventDatesRaw,
            contact: contactEmail,
            location,
            registerLink: registrationUrl,
            type
        });

    });

    // The same event can appear more than once on the page
    // (e.g. listed under a region section too) — de-dupe here.
    const seen = new Set();
    const unique = events.filter((e) => {
        const key = e.title + "|" + e.startDate;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });

    console.log(`📋 Parsed ${unique.length} events from MILSET`);

    for (const ev of unique) {

        await new Promise((resolve) => {
            db.run(
                `
                INSERT INTO exhibitions
                (title, country, city, startDate, endDate, registrationDeadline,
                 category, scope, organizer, website, registrationUrl, source,
                 dates, contact, location, registerLink, type)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT (title, startDate) DO UPDATE SET
                    registrationDeadline = EXCLUDED.registrationDeadline,
                    website = EXCLUDED.website,
                    registrationUrl = EXCLUDED.registrationUrl,
                    registerLink = EXCLUDED.registerLink,
                    updatedAt = CURRENT_TIMESTAMP
                `,
                [
                    ev.title, ev.country, ev.city, ev.startDate, ev.endDate,
                    ev.registrationDeadline, ev.category, ev.scope,
                    ev.organizer, ev.website, ev.registrationUrl, ev.source,
                    ev.dates, ev.contact, ev.location, ev.registerLink, ev.type
                ],
                function (err) {
                    if (err) {
                        console.error(
                            `❌ Failed to save "${ev.title}":`,
                            err.message
                        );
                    } else {
                        console.log(`✅ Saved: ${ev.title}`);
                    }
                    resolve();
                }
            );
        });

    }

    console.log("🎉 Done updating exhibitions.");
    process.exit(0);

}

scrapeExhibitions().catch((err) => {
    console.error("❌ Scraper failed:", err.message);
    process.exit(1);
});
