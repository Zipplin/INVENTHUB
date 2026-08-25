
require("dotenv").config();
const express = require("express");
const axios = require("axios");
const path = require("path");
const fs = require("fs");
const db = require("./database/database");
const multer = require("multer");
const session = require("express-session");
const http = require("http");
const https = require("https");
const { Server } = require("socket.io");
const { createClient } = require("@supabase/supabase-js");

const app = express();

// Render (and most hosts) set process.env.PORT and handle HTTPS
// themselves at the edge, so we just need plain HTTP there.
// Locally, we use mkcert certs to serve real HTTPS for testing.
const isProduction = !!process.env.PORT;

let server;

if (isProduction) {

    const PORT = process.env.PORT;
    server = http.createServer(app);

    server.listen(PORT, () => {
        console.log(`🚀 InventHub running on port ${PORT}`);
    });

} else {

    const HTTPS_PORT = process.env.HTTPS_PORT || 3443;
    const HTTP_PORT = process.env.HTTP_PORT || 3000;

    const httpsOptions = {
        key: fs.readFileSync(path.join(__dirname, "certs", "key.pem")),
        cert: fs.readFileSync(path.join(__dirname, "certs", "cert.pem"))
    };

    server = https.createServer(httpsOptions, app);

    const redirectApp = express();
    redirectApp.use((req, res) => {
        res.redirect(`https://${req.hostname}:${HTTPS_PORT}${req.url}`);
    });
    http.createServer(redirectApp).listen(HTTP_PORT, () => {
        console.log(`↪️  HTTP redirect running at http://localhost:${HTTP_PORT}`);
    });

    server.listen(HTTPS_PORT, () => {
        console.log(`🚀 InventHub running at https://localhost:${HTTPS_PORT}`);
    });

}

const io = new Server(server);

// Supabase Storage client — uploaded files (invention photos, profile
// pictures, product images, company logos) live here instead of on
// local disk, so they survive restarts/redeploys on Render.
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

const SUPABASE_BUCKET = "uploads";

// Multer now keeps the file in memory instead of writing to disk —
// we push it to Supabase Storage ourselves right after.
const upload = multer({ storage: multer.memoryStorage() });

// Runs after upload.single(...)/upload.fields(...) on any route.
// Pushes req.file (or each file in req.files) to Supabase Storage,
// then sets req.file.filename (same as multer's diskStorage used to)
// so every existing route below needs zero further changes.
async function pushToSupabase(req, res, next) {

    try {

        const filesToUpload = [];

        if (req.file) {
            filesToUpload.push(req.file);
        }

        if (req.files) {
            const fileList = Array.isArray(req.files)
                ? req.files
                : Object.values(req.files).flat();
            filesToUpload.push(...fileList);
        }

        for (const file of filesToUpload) {
            const filename = Date.now() + "-" + file.originalname;

            const { error } = await supabase.storage
                .from(SUPABASE_BUCKET)
                .upload(filename, file.buffer, {
                    contentType: file.mimetype
                });

            if (error) {
                console.error("❌ Supabase upload failed:", error.message);
                return res.status(500).send("Image upload failed.");
            }

            file.filename = filename;
        }

        next();

    } catch (err) {
        console.error("❌ Upload middleware error:", err.message);
        res.status(500).send("Image upload failed.");
    }

}

// Existing "/uploads/filename" links throughout the app (img tags,
// stored DB values) keep working unchanged — this just redirects
// them to the real file on Supabase's public CDN.
app.get("/uploads/:filename", (req, res) => {
    const { data } = supabase.storage
        .from(SUPABASE_BUCKET)
        .getPublicUrl(req.params.filename);
    res.redirect(data.publicUrl);
});

// Tell Express to use EJS
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

console.log("Views folder:", path.join(__dirname, "views"));
// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));
app.use(express.json());
app.set("trust proxy", 1);
app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: true,
        httpOnly: true,
        sameSite: "lax"
    }
}));
// Serve static files
app.use(express.static(__dirname));
// =======================
// Home Page
// =======================
app.get("/", (req, res) => {

    res.render("home");

});

// =======================
// Register User
// =======================
app.post("/register", (req, res) => {

    const {
        fullname,
        email,
        country,
        city,
        accountType,
        password
    } = req.body;

    const sql = `
        INSERT INTO users
        (fullname, email, country, city, accountType, password)
        VALUES (?, ?, ?, ?, ?, ?)
    `;

    db.run(sql, [fullname, email, country, city, accountType, password], function(err) {

        if (err) {
            console.log(err.message);
            return res.send("❌ Registration failed. Email may already exist.");
        }

        res.send(`
            <h2>✅ Registration Successful!</h2>
            <p>Your account has been created.</p>
            <a href="/login.html">Go to Login</a>
        `);

    });

});

// =======================
// Login User
// =======================
app.post("/login", (req, res) => {

    const { email, password } = req.body;

    db.get(
        "SELECT * FROM users WHERE email = ?",
        [email],
        (err, user) => {

            if (err) {
                return res.send("Database Error");
            }

            if (!user) {
                return res.send("❌ Email not found.");
            }

            if (user.password !== password) {
                return res.send("❌ Incorrect password.");
            }
req.session.user = user;

res.redirect("/dashboard");
            

        }
    );

});

// =======================
// Upload Invention
// =======================
app.post("/upload", upload.single("image"), pushToSupabase, (req, res) => {
    

    const {
        title,
        category,
        industry,
        country,
        description,
        stage,
        lookingFor
    } = req.body;
    const image = req.file ? req.file.filename : null;
    if (!req.session.user) {
    return res.redirect("/login.html");
}

const userId = req.session.user.id;

    const sql = `
        INSERT INTO inventions
(title, category, industry, country, description, stage, lookingFor, image, userId)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    db.run(
        sql,
       [
    title,
    category,
    industry,
    country,
    description,
    stage,
    lookingFor,
    image,
    userId
] ,
        function(err) {

            if (err) {
                console.log(err.message);
                return res.send("❌ Failed to publish invention.");
            }

            res.send(`
                <h2>🎉 Invention Published Successfully!</h2>

                <p>Your invention has been published on InventHub.</p>

                <a href="/dashboard">
                    Return to Dashboard
                </a>
            `);

        }
    );

});
app.post("/upload-profile", upload.single("image"), pushToSupabase, (req, res) => {

    if (!req.session.user) {
        return res.redirect("/login.html");
    }

    const image = req.file ? req.file.filename : null;

    if (!image) {
        return res.send("No image uploaded.");
    }

    db.run(
        "UPDATE users SET profileImage = ? WHERE id = ?",
        [image, req.session.user.id],
        function(err) {

            if (err) {
                return res.send(err.message);
            }

            req.session.user.profileImage = image;

            res.redirect("/dashboard");
        }
    );

});

// =======================
// Publish Marketplace Product
// =======================
app.post(
    "/marketplace/add",
    upload.single("image"),
    pushToSupabase,
    (req, res) => {

        if (!req.session.user) {
            return res.redirect("/login.html");
        }

        // Pro users only
        if (req.session.user.accountType !== "pro") {
            return res.redirect("/pro");
        }

        // Check marketplace product limit
        db.get(
            `
            SELECT COUNT(*) AS total
            FROM marketplace_products
            WHERE userId = ?
            `,
            [req.session.user.id],
            (countErr, result) => {

                if (countErr) {

                    console.error(
                        "❌ Could not check product limit:",
                        countErr.message
                    );

                    return res.send(
                        "Could not check marketplace limit."
                    );
                }

                // Maximum 10 active products
                if (result.total >= 10) {

                    return res.send(`
                        <h2>⚠️ Marketplace Limit Reached</h2>

                        <p>
                            Pro inventors can have a maximum
                            of 10 active marketplace products.
                        </p>

                        <a href="/marketplace">
                            Back to Marketplace
                        </a>
                    `);
                }

                const {
                    productName,
                    price,
                    category,
                    description
                } = req.body;

                const image =
                    req.file ? req.file.filename : null;

                if (!image) {
                    return res.send(
                        "Please upload a product image."
                    );
                }

                db.run(
                    `
                    INSERT INTO marketplace_products (
                        userId,
                        productName,
                        price,
                        category,
                        description,
                        image
                    )
                    VALUES (?, ?, ?, ?, ?, ?)
                    `,
                    [
                        req.session.user.id,
                        productName,
                        price,
                        category,
                        description,
                        image
                    ],
                    function (err) {

                        if (err) {

                            console.error(
                                "❌ Failed to publish marketplace product:",
                                err.message
                            );

                            return res.send(
                                "❌ Failed to publish product."
                            );
                        }

                        console.log(
                            "✅ Marketplace product published:",
                            this.lastID
                        );

                        res.redirect(
                            "/marketplace"
                        );

                    }
                );

            }
        );

    }
);

// =======================
// =======================
// Start Server
// =======================
app.get("/users", (req, res) => {

    db.all("SELECT * FROM users", [req.session.user.id], (err, rows) => {

        if (err) {
            return res.send(err.message);
        }

        res.json(rows);

    });

});
app.get("/dashboard", (req, res) => {
    if (!req.session.user) {
        return res.redirect("/login.html");
    }


    db.all(
`
SELECT
    inventions.*,
    users.fullname,
    users.profileImage,

    COUNT(DISTINCT likes.id) AS likes,

    0 AS isFollowing,

    (
        SELECT STRING_AGG(
            comments.comment || '||' || users.fullname,
            '%%%'
        )
        FROM comments
        INNER JOIN users
        ON comments.userId = users.id
        WHERE comments.inventionId = inventions.id
    ) AS comments

FROM inventions

INNER JOIN users
ON inventions.userId = users.id

LEFT JOIN likes
ON inventions.id = likes.inventionId


    

GROUP BY inventions.id, users.id

ORDER BY inventions.createdAt DESC
`,
[
],
(err, inventions) => {

    if (err) {
        return res.send(err.message);
    }
inventions.forEach(invention => {

    if (invention.comments) {

        invention.comments = invention.comments
            .split("%%%")
            .map(c => {

                const parts = c.split("||");

                return {
                    comment: parts[0],
                    fullname: parts[1]
                };

            });

    } else {

        invention.comments = [];

    }

});

const currentUserId = req.session.user.id;

db.get(`
    SELECT

        (SELECT COUNT(*)
         FROM inventions
         WHERE userId = ?) AS totalInventions,

        (SELECT COUNT(*)
         FROM likes
         INNER JOIN inventions
         ON likes.inventionId = inventions.id
         WHERE inventions.userId = ?) AS totalLikes,

        (SELECT COUNT(*)
         FROM followers
         WHERE followingId = ?) AS followers,

        (SELECT COUNT(*)
         FROM followers
         WHERE followerId = ?) AS following

`, [
    currentUserId,
    currentUserId,
    currentUserId,
    currentUserId
], (statsErr, stats) => {

    if (statsErr) {
        return res.send(statsErr.message);
    }

    res.render("dashboard", {
        fullname: req.session.user.fullname,
        userId: req.session.user.id,
        inventions: inventions,

        totalInventions: stats.totalInventions,
        totalLikes: stats.totalLikes,
        followers: stats.followers,
        following: stats.following
    });

});

});
});
    

app.get("/my-inventions", (req, res) => {

    if (!req.session.user) {
        return res.redirect("/login.html");
    }

    db.all(
        "SELECT * FROM inventions WHERE userId = ? ORDER BY createdAt DESC",
        [req.session.user.id],
        (err, inventions) => {

            if (err) {
                return res.send(err.message);
            }

            res.render("my-inventions", {
                fullname: req.session.user.fullname,
                inventions: inventions
            });

        }
    );

});

// =======================
// Followers
// =======================
app.get("/followers", (req, res) => {

    if (!req.session.user) {
        return res.redirect("/login.html");
    }

    const userId = req.session.user.id;

    db.all(
        `
        SELECT
            users.id,
            users.fullname,
            users.profileImage
        FROM followers
        INNER JOIN users
        ON followers.followerId = users.id
        WHERE followers.followingId = ?
        ORDER BY users.fullname ASC
        `,
        [userId],
        (err, followersList) => {

            if (err) {
                return res.send(err.message);
            }

            res.render("followers", {
                followers: followersList,
                fullname: req.session.user.fullname
            });

        }
    );

});
// =======================
// Following
// =======================
app.get("/following", (req, res) => {

    if (!req.session.user) {
        return res.redirect("/login.html");
    }

    const userId = req.session.user.id;

    db.all(
        `
        SELECT
            users.id,
            users.fullname,
            users.profileImage
        FROM followers
        INNER JOIN users
        ON followers.followingId = users.id
        WHERE followers.followerId = ?
        ORDER BY users.fullname ASC
        `,
        [userId],
        (err, followingList) => {

            if (err) {
                return res.send(err.message);
            }

            res.render("following", {
                following: followingList,
                fullname: req.session.user.fullname
            });

        }
    );

});
// =======================
// Delete Invention
// =======================
app.post("/delete/:id", (req, res) => {

    // User must be logged in
    if (!req.session.user) {
        return res.redirect("/login.html");
    }

    const inventionId = req.params.id;
    const userId = req.session.user.id;

    db.get(
        "SELECT image FROM inventions WHERE id = ? AND userId = ?",
        [inventionId, userId],
        (getErr, invention) => {

            // Other tables reference this invention (likes, comments,
            // bookmarks, interests, messages). Postgres blocks deleting
            // a row that's still referenced elsewhere, so we clear
            // those out first.
            const cleanupQueries = [
                ["DELETE FROM likes WHERE inventionId = ?", [inventionId]],
                ["DELETE FROM comments WHERE inventionId = ?", [inventionId]],
                ["DELETE FROM bookmarks WHERE inventionId = ?", [inventionId]],
                ["DELETE FROM interests WHERE inventionId = ?", [inventionId]],
                ["DELETE FROM messages WHERE inventionId = ?", [inventionId]]
            ];

            function runCleanup(index) {

                if (index >= cleanupQueries.length) {
                    return deleteInvention();
                }

                const [sql, params] = cleanupQueries[index];

                db.run(sql, params, (cleanupErr) => {

                    if (cleanupErr) {
                        console.error(
                            "⚠️ Cleanup step failed:",
                            cleanupErr.message
                        );
                    }

                    runCleanup(index + 1);

                });

            }

            function deleteInvention() {

                db.run(
                    "DELETE FROM inventions WHERE id = ? AND userId = ?",
                    [inventionId, userId],
                    async function(err) {

                        if (err) {
                            console.log(err.message);
                            return res.send("❌ Failed to delete invention.");
                        }

                        if (this.changes === 0) {
                            return res.send("❌ You are not allowed to delete this invention.");
                        }

                        // Also remove the image file itself from storage,
                        // so it doesn't sit around unused forever.
                        if (invention && invention.image) {
                            const { error: storageErr } = await supabase.storage
                                .from(SUPABASE_BUCKET)
                                .remove([invention.image]);

                            if (storageErr) {
                                console.error(
                                    "⚠️ Could not delete image file:",
                                    storageErr.message
                                );
                            }
                        }

                        res.redirect("/my-inventions");
                    }
                );

            }

            runCleanup(0);

        }
    );

});
// =======================
// Edit Invention
// =======================
app.get("/edit/:id", (req, res) => {

    if (!req.session.user) {
        return res.redirect("/login.html");
    }

    db.get(
        "SELECT * FROM inventions WHERE id = ? AND userId = ?",
        [req.params.id, req.session.user.id],
        (err, invention) => {

            if (err) {
                return res.send(err.message);
            }

            if (!invention) {
                return res.send("Invention not found.");
            }

            res.render("edit", {
                invention: invention
            });

        }
    );

});
// =======================
// Update Invention
// =======================
app.post("/update/:id", (req, res) => {

    if (!req.session.user) {
        return res.redirect("/login.html");
    }

    const {
        title,
        category,
        industry,
        country,
        description,
        stage,
        lookingFor
    } = req.body;

    db.run(
        `UPDATE inventions
         SET title=?,
             category=?,
             industry=?,
             country=?,
             description=?,
             stage=?,
             lookingFor=?
         WHERE id=? AND userId=?`,
        [
            title,
            category,
            industry,
            country,
            description,
            stage,
            lookingFor,
            req.params.id,
            req.session.user.id
        ],
        function(err) {

            if (err) {
                return res.send(err.message);
            }

            res.redirect("/my-inventions");

        }
    );

});

// =======================
// Public Inventor Profile
// =======================
app.get("/inventor/:id", (req, res) => {

    const userId = req.params.id;

   db.get(
    "SELECT * FROM users WHERE id = ?",
    [userId],
    (err, user) => {

        
        console.log("Database error:", err);
        console.log("User found:", user);
            if (err) {
                return res.send(err.message);
            }

            if (!user) {
                return res.send("Inventor not found.");
            }

            db.all(
                "SELECT * FROM inventions WHERE userId = ? ORDER BY createdAt DESC",
                [userId],
                (err, inventions) => {

                    if (err) {
                        return res.send(err.message);
                    }

                    // Count total inventions
                   const totalInventions = inventions.length;

db.get(
    `
    SELECT COUNT(*) AS totalLikes
    FROM likes
    INNER JOIN inventions
    ON likes.inventionId = inventions.id
    WHERE inventions.userId = ?
    `,
    [userId],
    (err, likeResult) => {

        if (err) {
            return res.send(err.message);
        }

        db.get(
            "SELECT COUNT(*) AS followers FROM followers WHERE followingId = ?",
            [userId],
            (err, followerResult) => {

                if (err) {
                    return res.send(err.message);
                }

                db.get(
                    "SELECT COUNT(*) AS following FROM followers WHERE followerId = ?",
                    [userId],
                    (err, followingResult) => {

                        if (err) {
                            return res.send(err.message);
                        }



                        res.render("inventor-profile", {
    user: user,
    inventions: inventions,
    totalInventions: totalInventions,
    totalLikes: likeResult.totalLikes,
    followers: followerResult.followers,
    following: followingResult.following,
    currentUserId: req.session.user ? req.session.user.id : null
});

                                        }
                );

            }
        );

    }
); // closes the totalLikes db.get

                }
            );

        }
    );

});

// =======================
// Search Inventions

// =======================
// Like Invention
// =======================
// =======================
// =======================
// Message Page
// =======================
app.get("/message/:receiverId/:inventionId", (req, res) => {

    if (!req.session.user) {
        return res.redirect("/login.html");
    }

    res.render("message", {
        receiverId: req.params.receiverId,
        inventionId: req.params.inventionId
    });

});

app.get("/messages/:receiverId", (req, res) => {

    if (!req.session.user) {
        return res.redirect("/login.html");
    }

    res.render("message", {
        receiverId: req.params.receiverId,
        inventionId: null
    });

});
// =======================
// Send Message
// =======================
app.post("/send-message", (req, res) => {

    if (!req.session.user) {
        return res.redirect("/login.html");
    }

    const senderId = req.session.user.id;
    const { receiverId, inventionId, message } = req.body;
    const actualInventionId = inventionId ? inventionId : null;

    db.run(
        `
        INSERT INTO messages
        (senderId, receiverId, inventionId, message)
        VALUES (?, ?, ?, ?)
        `,
        [
            senderId,
            receiverId,
            actualInventionId,
            message
        ],
        function(err) {

            if (err) {
                console.log(err.message);
                return res.send("❌ Failed to send message.");
            }

            res.redirect("/conversations");

        }
    );

});
// Inbox → Conversations
// =======================
app.get("/inbox", (req, res) => {

    if (!req.session.user) {
        return res.redirect("/login.html");
    }

    res.redirect("/conversations");

});
// =======================
// =======================
// =======================
// Like Invention + Notification
// =======================
app.post("/like/:id", (req, res) => {

    if (!req.session.user) {
        return res.redirect("/login.html");
    }

    const inventionId = req.params.id;
    const likerId = req.session.user.id;

    db.get(
        "SELECT * FROM inventions WHERE id = ?",
        [inventionId],
        (err, invention) => {

            if (err) {
                return res.send(err.message);
            }

            if (!invention) {
                return res.send("Invention not found.");
            }

            db.run(
                "INSERT INTO likes(userId, inventionId) VALUES(?, ?) ON CONFLICT (userId, inventionId) DO NOTHING",
                [likerId, inventionId],
                function(err) {

                    if (err) {
                        return res.send(err.message);
                    }

                    // Only create a notification if a new like was added
                    if (this.changes > 0 && invention.userId !== likerId) {

                        db.run(
                            `INSERT INTO notifications
                            (userId, message, link)
                            VALUES (?, ?, ?)`,
                            [
                                invention.userId,
                                `${req.session.user.fullname} liked your invention.`,
                                "/dashboard"
                            ]
                        );

                    }

                    res.redirect("/dashboard");

                }
            );

        }
    );

});
// =======================
// Check for New Messages
// =======================
app.get("/api/unread-messages", (req, res) => {

    if (!req.session.user) {
        return res.status(401).json({
            unread: 0
        });
    }

    db.get(
        `
        SELECT COUNT(*) AS unread
        FROM messages
        WHERE receiverId = ?
        AND isRead = 0
        `,
        [req.session.user.id],
        (err, result) => {

            if (err) {
                console.error(
                    "❌ Could not check messages:",
                    err.message
                );

                return res.status(500).json({
                    unread: 0
                });
            }

            res.json({
                unread: result.unread
            });

        }
    );

});
// =======================
// Conversations
// =======================
app.get("/conversations", (req, res) => {

    if (!req.session.user) {
        return res.redirect("/login.html");
    }

    db.all(
`
SELECT DISTINCT
    users.id,
    users.fullname,
    users.email
FROM users

INNER JOIN messages
ON (
    (messages.senderId = users.id AND messages.receiverId = ?)
    OR
    (messages.receiverId = users.id AND messages.senderId = ?)
)

WHERE users.id != ?
`,
[
    req.session.user.id,
    req.session.user.id,
    req.session.user.id
],
(err, conversations) => {

    if (err) {
        return res.send(err.message);
    }

    res.render("conversations", {
        conversations: conversations
    });

});

});
// =======================
// Open Chat
// =======================
app.get("/chat/:id", (req, res) => {

    if (!req.session.user) {
        return res.redirect("/login.html");
    }

    const otherUserId = req.params.id;

    db.get(
        "SELECT * FROM users WHERE id = ?",
        [otherUserId],
        (err, person) => {

            if (err) {
                return res.send(err.message);
            }

            db.all(
`
SELECT *
FROM messages
WHERE
(senderId=? AND receiverId=?)
OR
(senderId=? AND receiverId=?)
ORDER BY createdAt ASC
`,
[
req.session.user.id,
otherUserId,
otherUserId,
req.session.user.id
],
(err, messages)=>{

    if(err){
        return res.send(err.message);
    }

    res.render("chat",{
        person: person,
        messages: messages,
        currentUser: req.session.user
    });

});

        }
    );

});
// =======================
// Send Chat Message
// =======================
app.post("/chat/:id", (req, res) => {

    if (!req.session.user) {
        return res.redirect("/login.html");
    }

    db.run(
    `
    INSERT INTO messages
    (senderId, receiverId, message)
    VALUES (?, ?, ?)
    `,
    [
        req.session.user.id,
        req.params.id,
        req.body.message
    ],
    function(err){

        if(err){
            return res.send(err.message);
        }

        // Create notification
        db.run(
            `
            INSERT INTO notifications
            (userId, message, link)
            VALUES (?, ?, ?)
            `,
            [
                req.params.id,
                `${req.session.user.fullname} sent you a message.`,
                "/chat/" + req.session.user.id
            ]
        );

        res.redirect("/chat/" + req.params.id);

    }

);
});
// =======================
// Notifications
// =======================
app.get("/notifications", (req, res) => {

    if (!req.session.user) {
        return res.redirect("/login.html");
    }

    // Mark all notifications as read
    db.run(
        "UPDATE notifications SET isRead = 1 WHERE userId = ?",
        [req.session.user.id],
        (err) => {

            if (err) {
                return res.send(err.message);
            }

            db.all(
                `
                SELECT *
                FROM notifications
                WHERE userId = ?
                ORDER BY createdAt DESC
                `,
                [req.session.user.id],
                (err, notifications) => {

                    if (err) {
                        return res.send(err.message);
                    }

                    res.render("notifications", {
                        notifications: notifications
                    });

                }
            );

        }
    );

});
// =======================
// Logout
// =======================
app.get("/logout", (req, res) => {

    req.session.destroy((err) => {

        if (err) {
            return res.send("Failed to logout.");
        }

        res.redirect("/");

    });

});
// =======================
// Comment on Invention
// =======================
app.post("/comment/:id", (req, res) => {

    if (!req.session.user) {
        return res.redirect("/login.html");
    }

    const comment = req.body.comment;

    if (!comment || comment.trim() === "") {
        return res.redirect("/dashboard");
    }

    db.run(
        "INSERT INTO comments (userId, inventionId, comment) VALUES (?, ?, ?)",
        [
            req.session.user.id,
            req.params.id,
            comment
        ],
        function(err) {

            if (err) {
                return res.send(err.message);
            }

            res.redirect("/dashboard");

        }
    );

});
// =======================
// Follow Inventor
// =======================
app.post("/follow/:id", (req, res) => {

    if (!req.session.user) {
        return res.redirect("/login.html");
    }

    // Prevent following yourself
    if (req.session.user.id == req.params.id) {
        return res.redirect("/dashboard");
    }

    db.run(
        "INSERT INTO followers (followerId, followingId) VALUES (?, ?) ON CONFLICT (followerId, followingId) DO NOTHING",
        [
            req.session.user.id,
            req.params.id
        ],
        function(err) {

            if (err) {
                return res.send(err.message);
            }

            res.redirect("/dashboard");

        }
    );

});
// =======================
// Unfollow Inventor
// =======================
app.post("/unfollow/:id", (req, res) => {

    if (!req.session.user) {
        return res.redirect("/login.html");
    }

    db.run(
        "DELETE FROM followers WHERE followerId = ? AND followingId = ?",
        [
            req.session.user.id,
            req.params.id
        ],
        function(err) {

            if (err) {
                return res.send(err.message);
            }

            res.redirect("/dashboard");

        }
    );

});
// =======================
// Express Interest
// =======================
app.post("/interest/:id", (req, res) => {

    if (!req.session.user) {
        return res.redirect("/login.html");
    }

    db.run(
        `
        INSERT INTO interests (investorId, inventionId)
        VALUES (?, ?)
        `,
        [
            req.session.user.id,
            req.params.id
        ],
        function(err) {

            if (err) {
    return res.send(err.message);
}

// Find the owner of the invention
db.get(
    "SELECT userId, title FROM inventions WHERE id = ?",
    [req.params.id],
    (err, invention) => {

        if (!err && invention) {

            db.run(
                "INSERT INTO notifications (userId, message) VALUES (?, ?)",
                [
                    invention.userId,
                    `${req.session.user.fullname} is interested in investing in your invention "${invention.title}".`
                ]
            );

        }

        res.send(`
            <h2>🎉 Interest Sent!</h2>

            <p>The inventor has been notified of your interest.</p>

            <a href="/dashboard">Return to Dashboard</a>
        `);

    }
);

        }

    );

});
// =======================
// Interested Investors
// =======================
app.get("/interested-investors", (req, res) => {

    if (!req.session.user) {
        return res.redirect("/login.html");
    }

    db.all(
        `
        SELECT
            interests.investorId,
            interests.inventionId,
            interests.createdAt,
            users.fullname,
            inventions.title

        FROM interests

        INNER JOIN inventions
            ON interests.inventionId = inventions.id

        INNER JOIN users
            ON interests.investorId = users.id

        WHERE inventions.userId = ?

        ORDER BY interests.createdAt DESC
        `,
        [req.session.user.id],
        (err, investors) => {

            if (err) {
                return res.send(err.message);
            }

            res.render("interested-investors", {
                investors: investors
            });

        }
    );

});
// =======================
// View Single Invention
// =======================
app.get("/invention/:id", (req, res) => {

    db.get(
        `
        SELECT
            inventions.*,
            users.fullname,
users.accountType,
COUNT(DISTINCT likes.id) AS likes
        FROM inventions

        INNER JOIN users
            ON inventions.userId = users.id

        LEFT JOIN likes
            ON inventions.id = likes.inventionId

        WHERE inventions.id = ?

        GROUP BY inventions.id, users.id
        `,
        [req.params.id],
        (err, invention) => {

            if (err) {
                return res.send(err.message);
            }

            if (!invention) {
                return res.send("Invention not found.");
            }

            res.render("invention", {
                invention: invention
            });

        }
    );

});
// =======================
// Bookmark Invention
// =======================
app.post("/bookmark/:id", (req, res) => {

    if (!req.session.user) {
        return res.redirect("/login.html");
    }

    db.run(
        `
        INSERT INTO bookmarks (userId, inventionId)
        VALUES (?, ?)
        ON CONFLICT (userId, inventionId) DO NOTHING
        `,
        [
            req.session.user.id,
            req.params.id
        ],
        function(err) {

            if (err) {
                return res.send(err.message);
            }

            res.redirect("/dashboard");

        }

    );

});
// =======================
// Saved Bookmarks
// =======================
app.get("/bookmarks", (req, res) => {

    if (!req.session.user) {
        return res.redirect("/login.html");
    }

    db.all(
        `
        SELECT
            inventions.*,
            users.fullname

        FROM bookmarks

        INNER JOIN inventions
            ON bookmarks.inventionId = inventions.id

        INNER JOIN users
            ON inventions.userId = users.id

        WHERE bookmarks.userId = ?

        ORDER BY bookmarks.createdAt DESC
        `,
        [req.session.user.id],
        (err, bookmarks) => {

            if (err) {
                return res.send(err.message);
            }

            res.render("bookmarks", {
                bookmarks: bookmarks
            });

        }
    );

});
// =======================
// Remove Bookmark
// =======================
app.post("/remove-bookmark/:id", (req, res) => {

    if (!req.session.user) {
        return res.redirect("/login.html");
    }

    db.run(
        `
        DELETE FROM bookmarks
        WHERE userId = ?
        AND inventionId = ?
        `,
        [
            req.session.user.id,
            req.params.id
        ],
        function(err) {

            if (err) {
                return res.send(err.message);
            }

            res.redirect("/bookmarks");

        }

    );

});
// =======================
// AI Assistant
// =======================

// Open AI page
app.get("/ai", (req, res) => {

    if (!req.session.user) {
        return res.redirect("/login.html");
    }

    res.render("ai", {
        answer: null
    });

});

// Handle AI question
app.post("/ai", (req, res) => {

    if (!req.session.user) {
        return res.redirect("/login.html");
    }

    const prompt = req.body.prompt;

    // Temporary AI response
    const answer =
        "You asked: " + prompt +
        "\n\nThis is where InventHub AI will answer your questions.";

    res.render("ai", {
        answer: answer
    });

});



// =======================
// Video Call - Socket.IO
// =======================

io.on("connection", (socket) => {
socket.on("call-user", (roomId) => {

    console.log("📞 Call request received for room:", roomId);

    socket.to(roomId).emit("incoming-call");

});
socket.on("accept-call", (roomId) => {

    socket.to(roomId).emit("call-accepted");

});
socket.on("decline-call", (roomId) => {
    socket.to(roomId).emit("call-declined");
});
    console.log("📞 Video call socket connected:", socket.id);

    socket.on("join-call", (roomId) => {

        socket.join(roomId);

        console.log(
            `📹 Socket ${socket.id} joined call room ${roomId}`
        );

        socket.to(roomId).emit("user-joined", socket.id);

    });

    socket.on("offer", ({ roomId, offer }) => {

        socket.to(roomId).emit("offer", offer);

    });

    socket.on("answer", ({ roomId, answer }) => {

        socket.to(roomId).emit("answer", answer);

    });

    socket.on("ice-candidate", ({ roomId, candidate }) => {

        socket.to(roomId).emit("ice-candidate", candidate);

    });

    socket.on("end-call", (roomId) => {

        socket.to(roomId).emit("call-ended");

    });

    socket.on("disconnect", () => {

        console.log(
            "📞 Video call socket disconnected:",
            socket.id
        );

    });

});


// =======================
// Video Call Page
// =======================

app.get("/video-call/:roomId", (req, res) => {

    if (!req.session.user) {
        return res.redirect("/login.html");
    }

    const user = req.session.user;

    if (user.accountType !== "pro") {
        return res.redirect("/pro");
    }

    if (
    user.proExpiresAt &&
    new Date(user.proExpiresAt) < new Date()
) {

        user.accountType = "free";
        user.proExpiresAt = null;

        return res.redirect("/pro");
    }

    res.render("video-call", {
        roomId: req.params.roomId
    });

});
// =======================
// Exhibitions
// =======================


app.get("/exhibitions", (req, res) => {

    if (!req.session.user) {
        return res.redirect("/login.html");
    }

    db.all(
        `SELECT * FROM exhibitions ORDER BY dates ASC`,
        [],
        (err, exhibitions) => {

            if (err) {
                console.error(
                    "❌ Could not load exhibitions:",
                    err.message
                );

                return res.status(500).send(
                    "Could not load exhibitions."
                );
            }

            res.render("exhibitions", {
    exhibitions: exhibitions,
    user: req.session.user
});

        }
    );

});
app.get("/pro", (req, res) => {

    if (!req.session.user) {
        return res.redirect("/login.html");
    }

    res.render("pro", {
        user: req.session.user
    });

});
// =======================
// Marketplace
// =======================
app.get("/marketplace", (req, res) => {

    if (!req.session.user) {
        return res.redirect("/login.html");
    }

    db.all(
        `
        SELECT
            marketplace_products.*,
           users.fullname,
users.accountType,
users.companyName,
users.companyLogo

        FROM marketplace_products

        INNER JOIN users
            ON marketplace_products.userId = users.id

        ORDER BY marketplace_products.createdAt DESC
        `,
        [],
        (err, products) => {

            if (err) {
                console.error(
                    "❌ Could not load marketplace:",
                    err.message
                );

                return res.status(500).send(
                    "Could not load marketplace."
                );
            }

            res.render("marketplace", {
                products: products,
                user: req.session.user
            });

        }
    );

});
// =======================
// View Marketplace Product
// =======================
app.get("/marketplace/product/:id", (req, res) => {

    if (!req.session.user) {
        return res.redirect("/login.html");
    }

    db.get(
        `
        SELECT
            marketplace_products.*,
            users.fullname,
            users.email,
            users.accountType,
            users.companyName,
            users.companyLogo

        FROM marketplace_products

        INNER JOIN users
            ON marketplace_products.userId = users.id

        WHERE marketplace_products.id = ?
        `,
        [req.params.id],
        (err, product) => {

            if (err) {
                console.error(
                    "❌ Could not load product:",
                    err.message
                );

                return res.status(500).send(
                    "Could not load product."
                );
            }

            if (!product) {
                return res.send(
                    "Product not found."
                );
            }

            res.render("product", {
                product: product
            });

        }
    );

});
// =======================
// Edit Marketplace Product
// =======================

app.get("/marketplace/edit/:id", (req, res) => {

    if (!req.session.user) {
        return res.redirect("/login.html");
    }

    if (req.session.user.accountType !== "pro") {
        return res.redirect("/pro");
    }

    db.get(
        `
        SELECT *
        FROM marketplace_products
        WHERE id = ? AND userId = ?
        `,
        [
            req.params.id,
            req.session.user.id
        ],
        (err, product) => {

            if (err) {
                return res.send(err.message);
            }

            if (!product) {
                return res.send(
                    "Product not found or you are not allowed to edit it."
                );
            }

            res.render("edit-product", {
                product: product
            });

        }
    );

});


app.post(
    "/marketplace/edit/:id",
    upload.single("image"),
    pushToSupabase,
    (req, res) => {

        if (!req.session.user) {
            return res.redirect("/login.html");
        }

        if (req.session.user.accountType !== "pro") {
            return res.redirect("/pro");
        }

        const {
            productName,
            price,
            category,
            description
        } = req.body;

        const newImage =
            req.file ? req.file.filename : null;

        let sql;
        let params;

        if (newImage) {

            sql = `
                UPDATE marketplace_products
                SET
                    productName = ?,
                    price = ?,
                    category = ?,
                    description = ?,
                    image = ?
                WHERE id = ?
                AND userId = ?
            `;

            params = [
                productName,
                price,
                category,
                description,
                newImage,
                req.params.id,
                req.session.user.id
            ];

        } else {

            sql = `
                UPDATE marketplace_products
                SET
                    productName = ?,
                    price = ?,
                    category = ?,
                    description = ?
                WHERE id = ?
                AND userId = ?
            `;

            params = [
                productName,
                price,
                category,
                description,
                req.params.id,
                req.session.user.id
            ];

        }

        db.run(
            sql,
            params,
            function(err) {

                if (err) {
                    return res.send(err.message);
                }

                if (this.changes === 0) {
                    return res.send(
                        "Product not found or update not allowed."
                    );
                }

                res.redirect("/marketplace");

            }
        );

    }
);
// =======================
// Delete Marketplace Product
// =======================

app.post("/marketplace/delete/:id", (req, res) => {

    if (!req.session.user) {
        return res.redirect("/login.html");
    }

    if (req.session.user.accountType !== "pro") {
        return res.redirect("/pro");
    }

    db.get(
        "SELECT image FROM marketplace_products WHERE id = ? AND userId = ?",
        [req.params.id, req.session.user.id],
        (getErr, product) => {

            db.run(
                `
                DELETE FROM marketplace_products
                WHERE id = ? AND userId = ?
                `,
                [
                    req.params.id,
                    req.session.user.id
                ],
                async function(err) {

                    if (err) {
                        console.error(
                            "❌ Failed to delete marketplace product:",
                            err.message
                        );

                        return res.send(
                            "❌ Failed to delete product."
                        );
                    }

                    if (this.changes === 0) {
                        return res.send(
                            "❌ Product not found or you are not allowed to delete it."
                        );
                    }

                    if (product && product.image) {
                        const { error: storageErr } = await supabase.storage
                            .from(SUPABASE_BUCKET)
                            .remove([product.image]);

                        if (storageErr) {
                            console.error(
                                "⚠️ Could not delete product image:",
                                storageErr.message
                            );
                        }
                    }

                    console.log(
                        "✅ Marketplace product deleted:",
                        req.params.id
                    );

                    res.redirect("/marketplace");

                }
            );

        }
    );

});
// =======================
// Add Marketplace Product
// =======================
app.get("/marketplace/add", (req, res) => {

    if (!req.session.user) {
        return res.redirect("/login.html");
    }

    if (req.session.user.accountType !== "pro") {
        return res.redirect("/pro");
    }

    res.render("sell-product", {
        user: req.session.user
    });

});
// =======================
// Pro Company Profile
// =======================

app.get("/company-profile", (req, res) => {

    if (!req.session.user) {
        return res.redirect("/login.html");
    }

    // Pro users only
    if (req.session.user.accountType !== "pro") {
        return res.redirect("/pro");
    }

    // Get latest company information
    db.get(
        `
        SELECT
            companyName,
            companyLogo,
            companyDescription
        FROM users
        WHERE id = ?
        `,
        [req.session.user.id],
        (err, company) => {

            if (err) {
                return res.send(err.message);
            }

            const user = {
                ...req.session.user,
                ...company
            };

            res.render("company-profile", {
                user: user
            });

        }
    );

});


app.post(
    "/company-profile",
    upload.single("companyLogo"),
    pushToSupabase,
    (req, res) => {

        if (!req.session.user) {
            return res.redirect("/login.html");
        }

        // Pro users only
        if (req.session.user.accountType !== "pro") {
            return res.redirect("/pro");
        }

        const {
            companyName,
            companyDescription
        } = req.body;

        const companyLogo =
            req.file
                ? req.file.filename
                : null;

        // If no new logo was uploaded,
        // keep the existing logo.
        if (companyLogo) {

            db.run(
                `
                UPDATE users
                SET
                    companyName = ?,
                    companyLogo = ?,
                    companyDescription = ?
                WHERE id = ?
                `,
                [
                    companyName,
                    companyLogo,
                    companyDescription,
                    req.session.user.id
                ],
                function(err) {

                    if (err) {
                        return res.send(err.message);
                    }

                    res.redirect(
                        "/company-profile"
                    );

                }
            );

        } else {

            db.run(
                `
                UPDATE users
                SET
                    companyName = ?,
                    companyDescription = ?
                WHERE id = ?
                `,
                [
                    companyName,
                    companyDescription,
                    req.session.user.id
                ],
                function(err) {

                    if (err) {
                        return res.send(err.message);
                    }

                    res.redirect(
                        "/company-profile"
                    );

                }
            );

        }

    }
);
// =======================
// InventHub Pro Payment
// =======================

app.post("/pro/upgrade", async (req, res) => {

    if (!req.session.user) {
        return res.status(401).json({
            success: false,
            message: "Please login first."
        });
    }

    try {

        const response = await axios.post(
            "https://api.paystack.co/transaction/initialize",
            {
                email: req.session.user.email,
                amount: 100000,
                callback_url: isProduction
                    ? `https://${req.hostname}/pro/payment-success`
                    : `https://localhost:${process.env.HTTPS_PORT || 3443}/pro/payment-success`
            },
            {
                headers: {
                    Authorization:
                        `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
                    "Content-Type":
                        "application/json"
                }
            }
        );

        if (!response.data.status) {

            return res.status(400).json({
                success: false,
                message:
                    "Could not initialize payment."
            });

        }

        res.json({
            success: true,
            authorization_url:
                response.data.data.authorization_url
        });

    } catch (error) {

        console.error(
            "❌ Paystack error:",
            error.response?.data ||
            error.message
        );

        res.status(500).json({
            success: false,
            message:
                "Payment could not be started."
        });

    }

});
app.get("/pro/payment-success", async (req, res) => {

    if (!req.session.user) {
        return res.redirect("/login");
    }

    const reference = req.query.reference;

    if (!reference) {
        return res.send("❌ Payment reference missing.");
    }

    try {

        const response = await axios.get(
            `https://api.paystack.co/transaction/verify/${reference}`,
            {
                headers: {
                    Authorization:
                        `Bearer ${process.env.PAYSTACK_SECRET_KEY}`
                }
            }
        );

        const payment = response.data.data;

        if (
            payment.status !== "success" ||
            payment.amount !== 100000
        ) {
            return res.send(
                "❌ Payment was not successful."
            );
        }

      // Activate Pro account
const expiresAt = new Date();

expiresAt.setDate(
    expiresAt.getDate() + 30
);

db.run(
    `
    UPDATE users
    SET
        accountType = ?,
        proExpiresAt = ?
    WHERE id = ?
    `,
    [
        "pro",
        expiresAt.toISOString(),
        req.session.user.id
    ],
    function (err) {

        if (err) {

            console.error(
                "❌ Could not activate Pro:",
                err.message
            );

            return res.send(
                "Payment succeeded, but Pro activation failed."
            );
        }

        console.log(
            "✅ Pro activated for user:",
            req.session.user.id
        );

        req.session.user.accountType = "pro";
        req.session.user.proExpiresAt =
            expiresAt.toISOString();

        res.redirect(
            "/pro?payment=success"
        );

    }
);
            
           
    } catch (error) {

        console.error(
            "❌ Payment verification error:",
            error.response?.data ||
            error.message
        );

        res.send(
            "❌ Could not verify payment."
        );
    }

});