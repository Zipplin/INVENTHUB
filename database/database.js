require("dotenv").config();
const { Pool } = require("pg");

// Supabase requires SSL, but its certificate isn't in Node's
// default trust store, so we relax verification here.
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

pool.on("error", (err) => {
    console.error("❌ Unexpected database error:", err.message);
});

// Converts "?" placeholders (SQLite style) into "$1, $2..." (Postgres style)
function toPgQuery(sql) {
    let i = 0;
    return sql.replace(/\?/g, () => `$${++i}`);
}

function normalizeArgs(params, callback) {
    if (typeof params === "function") {
        return { params: [], callback: params };
    }
    return { params: params || [], callback };
}

// Postgres lowercases unquoted column names (userId -> userid), but
// server.js and the EJS views expect the original camelCase names.
// This maps every lowercased column back to its real camelCase name
// so the rest of the app doesn't need to change at all.
const COLUMN_MAP = {
    accounttype: "accountType",
    profileimage: "profileImage",
    ispro: "isPro",
    proexpiresat: "proExpiresAt",
    companydescription: "companyDescription",
    companyname: "companyName",
    companylogo: "companyLogo",
    lookingfor: "lookingFor",
    createdat: "createdAt",
    userid: "userId",
    senderid: "senderId",
    receiverid: "receiverId",
    inventionid: "inventionId",
    isread: "isRead",
    followerid: "followerId",
    followingid: "followingId",
    investorid: "investorId",
    startdate: "startDate",
    enddate: "endDate",
    registrationdeadline: "registrationDeadline",
    registrationurl: "registrationUrl",
    updatedat: "updatedAt",
    registerlink: "registerLink",
    productname: "productName",
    totalinventions: "totalInventions",
    totallikes: "totalLikes",
    isfollowing: "isFollowing",
    resettoken: "resetToken",
    resettokenexpires: "resetTokenExpires",
    isadmin: "isAdmin",
    issuspended: "isSuspended"
};

function fixRowKeys(row) {
    if (!row) return row;

    const fixed = {};
    for (const key in row) {
        const properKey = COLUMN_MAP[key] || key;
        fixed[properKey] = row[key];
    }
    return fixed;
}

function fixRowsKeys(rows) {
    return rows.map(fixRowKeys);
}

const db = {

    // Mimics sqlite3's db.get — returns a single row (or undefined)
    get(sql, params, callback) {
        const args = normalizeArgs(params, callback);

        pool.query(toPgQuery(sql), args.params)
            .then((result) => {
                args.callback(null, fixRowKeys(result.rows[0]));
            })
            .catch((err) => {
                console.error("❌ db.get error:", err.message, "\nQuery:", sql);
                args.callback(err);
            });
    },

    // Mimics sqlite3's db.all — returns an array of rows
    all(sql, params, callback) {
        const args = normalizeArgs(params, callback);

        pool.query(toPgQuery(sql), args.params)
            .then((result) => {
                args.callback(null, fixRowsKeys(result.rows));
            })
            .catch((err) => {
                console.error("❌ db.all error:", err.message, "\nQuery:", sql);
                args.callback(err);
            });
    },

    // Mimics sqlite3's db.run — for INSERT/UPDATE/DELETE.
    // Provides this.lastID (for INSERTs) and this.changes, same as sqlite3 did.
    run(sql, params, callback) {
        const args = normalizeArgs(params, callback);

        let query = toPgQuery(sql);
        const isInsert = /^\s*INSERT\s+INTO/i.test(query);

        // Auto-add RETURNING id so we can report lastID like sqlite3 did
        if (isInsert && !/RETURNING/i.test(query)) {
            query += " RETURNING id";
        }

        pool.query(query, args.params)
            .then((result) => {
                const context = {
                    lastID: isInsert && result.rows[0] ? result.rows[0].id : undefined,
                    changes: result.rowCount
                };

                if (args.callback) {
                    args.callback.call(context, null);
                }
            })
            .catch((err) => {
                console.error("❌ db.run error:", err.message, "\nQuery:", query);
                if (args.callback) {
                    args.callback.call({}, err);
                }
            });
    }

};

module.exports = db;
