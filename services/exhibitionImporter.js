const axios = require("axios");
const cheerio = require("cheerio");
const db = require("../database/database");

const MILSET_URL = "https://milset.org/events";

async function importExhibitions() {

    console.log("🔎 Connecting to MILSET...");

    try {

        const response = await axios.get(MILSET_URL, {
            timeout: 60000,
            headers: {
                "User-Agent":
                    "Mozilla/5.0 InventHub Exhibition Importer"
            }
        });

        console.log("✅ MILSET page downloaded");

        const $ = cheerio.load(response.data);

        console.log(
            "📄 Page title:",
            $("title").text().trim()
        );

        const exhibitions = [];

        $("h3").each((index, element) => {

            const title = $(element)
                .text()
                .trim();

            if (!title) {
                return;
            }

            // Find the event container
            const container = $(element)
                .parents()
                .filter(function () {

                    const text = $(this)
                        .text()
                        .replace(/\s+/g, " ")
                        .trim();

                    return (
                        text.includes("Event dates:") &&
                        text.includes("Location:") &&
                        text.includes("Organizer:")
                    );

                })
                .first();

            if (!container.length) {
                return;
            }

            const text = container
                .text()
                .replace(/\s+/g, " ")
                .trim();

            // Extract event dates
            const datesMatch = text.match(
                /Event dates:\s*(.*?)\s*Register deadline:/
            );

            // Extract registration deadline
            const deadlineMatch = text.match(
                /Register deadline:\s*(.*?)\s*Organizer:/
            );

            // Extract organizer
            const organizerMatch = text.match(
                /Organizer:\s*(.*?)\s*Location:/
            );

            // Extract location
            const locationMatch = text.match(
                /Location:\s*(.*?)\s*Type:/
            );

            // Extract type
            const typeMatch = text.match(
                /Type:\s*(.*?)\s*Scope:/
            );

            // Extract scope
            const scopeMatch = text.match(
                /Scope:\s*(.*?)\s*Contact:/
            );

            // Extract contact
            const contactMatch = text.match(
                /Contact:\s*(.*?)(?:MILSET|$)/
            );

            let website = "";
            let registerLink = "";

            container.find("a").each((i, link) => {

                const linkText = $(link)
                    .text()
                    .trim()
                    .toLowerCase();

                const href = $(link).attr("href");

                if (!href) {
                    return;
                }

                if (linkText.includes("register")) {
                    registerLink = new URL(
                        href,
                        MILSET_URL
                    ).href;
                }

                if (linkText.includes("website")) {
                    website = new URL(
                        href,
                        MILSET_URL
                    ).href;
                }

            });

            exhibitions.push({

                title,

                dates: datesMatch
                    ? datesMatch[1].trim()
                    : "",

                registrationDeadline: deadlineMatch
                    ? deadlineMatch[1].trim()
                    : "",

                organizer: organizerMatch
                    ? organizerMatch[1].trim()
                    : "",

                location: locationMatch
                    ? locationMatch[1].trim()
                    : "",

                type: typeMatch
                    ? typeMatch[1].trim()
                    : "",

                scope: scopeMatch
                    ? scopeMatch[1].trim()
                    : "",

                contact: contactMatch
                    ? contactMatch[1].trim()
                    : "",

                website,

                registerLink

            });

        });

        console.log("");
        console.log(
            `🎉 Exhibitions found: ${exhibitions.length}`
        );

        console.log("");

        exhibitions.forEach((event, index) => {

            console.log(
                `========== Exhibition ${index + 1} ==========`
            );

            console.log(
                "📌 Name:",
                event.title
            );

            console.log(
                "📅 Dates:",
                event.dates
            );

            console.log(
                "⏰ Register deadline:",
                event.registrationDeadline
            );

            console.log(
                "🏢 Organizer:",
                event.organizer
            );

            console.log(
                "📍 Location:",
                event.location
            );

            console.log(
                "🧪 Type:",
                event.type
            );

            console.log(
                "🌍 Scope:",
                event.scope
            );

            console.log(
                "🔗 Website:",
                event.website || "Not available"
            );

            console.log(
                "📝 Register:",
                event.registerLink || "Not available"
            );

            console.log("");

        });
                // =========================
        // Save exhibitions to database
        // =========================

        for (const event of exhibitions) {

            db.run(
                `
                INSERT OR IGNORE INTO exhibitions (
                    title,
                    dates,
                    registrationDeadline,
                    organizer,
                    location,
                    type,
                    scope,
                    contact,
                    website,
                    registerLink
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `,
                [
                    event.title,
                    event.dates,
                    event.registrationDeadline,
                    event.organizer,
                    event.location,
                    event.type,
                    event.scope,
                    event.contact,
                    event.website,
                    event.registerLink
                ],
                function (err) {

                    if (err) {

                        console.error(
                            "❌ Could not save exhibition:",
                            err.message
                        );

                        return;
                    }

                    db.run(
                        `
                        UPDATE exhibitions
                        SET
                            registrationDeadline = ?,
                            organizer = ?,
                            location = ?,
                            type = ?,
                            scope = ?,
                            contact = ?,
                            website = ?,
                            registerLink = ?
                        WHERE title = ?
                        AND dates = ?
                        `,
                        [
                            event.registrationDeadline,
                            event.organizer,
                            event.location,
                            event.type,
                            event.scope,
                            event.contact,
                            event.website,
                            event.registerLink,
                            event.title,
                            event.dates
                        ]
                    );

                }
            );

        }

        console.log(
            `💾 ${exhibitions.length} exhibitions sent to database`
        );

        return exhibitions;
    } catch (error) {

        console.error(
            "❌ MILSET import failed:",
            error.message
        );

    }

}

module.exports = {
    importExhibitions
};

importExhibitions();