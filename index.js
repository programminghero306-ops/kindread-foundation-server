require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const { betterAuth } = require("better-auth");
const { mongodbAdapter } = require("@better-auth/mongo-adapter");

const requiredEnv = ["MONGODB_URI", "JWT_SECRET"];
const missingEnv = requiredEnv.filter((key) => !process.env[key]);
if (missingEnv.length) {
  console.error(`Missing required environment variables: ${missingEnv.join(", ")}`);
  process.exit(1);
}

const app = express();
const port = process.env.PORT || 5000;
const dbName = process.env.DB_NAME || "kindredDB";
const TIME_ZONE = process.env.TIME_ZONE || "Asia/Dhaka";

const defaultFrontendOrigins = [
  "https://kindred-foundation.vercel.app",
  "https://kindred-foundation-client.vercel.app",
];

const allowedOrigins = Array.from(
  new Set(
    (process.env.CLIENT_ORIGIN || "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean)
      .concat(defaultFrontendOrigins)
  )
);

// Public URL of this API. Render exposes RENDER_EXTERNAL_URL automatically.
const publicBaseUrl =
  process.env.BETTER_AUTH_URL ||
  process.env.RENDER_EXTERNAL_URL ||
  `http://localhost:${port}`;

const trustedOrigins = allowedOrigins.length
  ? allowedOrigins
  : ["http://localhost:3000", "http://localhost:5173", publicBaseUrl];

// Render terminates TLS in front of the app, so trust its proxy headers.
app.set("trust proxy", 1);
app.use(helmet());
app.use(
  cors({
    // Without CLIENT_ORIGIN, reflect the request origin (local development).
    origin: allowedOrigins.length ? allowedOrigins : true,
    credentials: true,
  })
);
app.use(express.json({ limit: "100kb" }));

const client = new MongoClient(process.env.MONGODB_URI, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

// ---------- Helpers ----------

const normalizeEmail = (value) =>
  typeof value === "string" ? value.trim().toLowerCase() : "";

const getTokenEmail = (decoded) =>
  normalizeEmail(decoded?.email || decoded?.userEmail || decoded?.user?.email);

const isValidEmail = (value) =>
  typeof value === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

const publicUser = (user) => ({
  _id: user._id,
  name: user.name,
  email: user.email,
  photoURL: user.photoURL || "",
});

const createToken = (user) =>
  jwt.sign(
    {
      sub: String(user._id),
      email: normalizeEmail(user.email),
      name: user.name,
    },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || "7d" }
  );

// Today's date as "YYYY-MM-DD" in Bangladesh time
const getToday = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

const EVENT_TYPES = new Set([
  "Cleanup",
  "Plantation",
  "Donation",
  "Food Drive",
  "Education",
  "Health",
  "Fundraiser",
  "Community",
  "Other",
]);

const normalizeEventType = (value) => {
  if (!isNonEmptyString(value)) return "";

  const key = value.trim().toLowerCase().replace(/[_\s]+/g, "-");
  const aliases = {
    cleanup: "Cleanup",
    plantation: "Plantation",
    "tree-planting": "Plantation",
    donation: "Donation",
    "food-drive": "Food Drive",
    education: "Education",
    health: "Health",
    fundraiser: "Fundraiser",
    community: "Community",
    other: "Other",
  };

  return aliases[key] || "";
};

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const isNonEmptyString = (value) =>
  typeof value === "string" && value.trim().length > 0;

const isValidDateString = (value) => {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
};

const toDateKey = (value) => {
  if (!value) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
};

// Create = every required field must be sent.
// Update (partial) = only the fields that were sent are checked.
const validateEventFields = (body, { partial = false } = {}) => {
  const data = {};
  const errors = [];
  const read = (field) => body?.[field];

  if (!partial || read("title") !== undefined) {
    if (!isNonEmptyString(read("title"))) {
      errors.push("title is required");
    } else {
      data.title = read("title").trim();
    }
  }

  if (!partial || read("eventType") !== undefined) {
    const rawEventType = isNonEmptyString(read("eventType"))
      ? read("eventType").trim()
      : "";
    const eventType = normalizeEventType(rawEventType);
    if (!rawEventType) {
      errors.push("eventType is required");
    } else if (!EVENT_TYPES.has(eventType)) {
      errors.push(`eventType must be one of: ${[...EVENT_TYPES].join(", ")}`);
    } else {
      data.eventType = eventType;
    }
  }

  if (!partial || read("eventDate") !== undefined) {
    const eventDate = read("eventDate");
    if (!isValidDateString(eventDate)) {
      errors.push("eventDate must be a valid date in YYYY-MM-DD format");
    } else if (eventDate < getToday()) {
      errors.push("eventDate cannot be in the past");
    } else {
      data.eventDate = eventDate;
    }
  }

  ["description", "thumbnail", "location"].forEach((field) => {
    const value = read(field);
    if (value === undefined) return;
    if (typeof value !== "string") {
      errors.push(`${field} must be a string`);
    } else {
      data[field] = value.trim();
    }
  });

  return { data, errors };
};

// ---------- JWT middleware ----------
// Reads "Authorization: Bearer <token>", verifies it, and makes sure the
// token email matches any email sent in the query or body.
function authenticate(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7).trim()
    : authHeader.trim();

  if (!token) {
    return res.status(401).send({ message: "Authorization token is required" });
  }

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (error) {
    return res.status(401).send({ message: "Invalid or expired token" });
  }

  const tokenEmail = getTokenEmail(decoded);
  if (!tokenEmail) {
    return res.status(401).send({ message: "Token does not contain an email" });
  }

  req.user = { ...decoded, email: tokenEmail };

  const requestedEmail = normalizeEmail(
    req.query.email ||
      req.body?.email ||
      req.body?.userEmail ||
      req.body?.creatorEmail ||
      req.body?.user?.email
  );

  if (requestedEmail && requestedEmail !== tokenEmail) {
    return res
      .status(403)
      .send({ message: "Token email does not match the requested email" });
  }

  next();
}

app.get("/", (req, res) => {
  res.send("Kindred Foundation server is running");
});

async function run() {
  try {
    await client.connect();
    console.log("Connected to MongoDB");

    const db = client.db(dbName);
    const eventsCollection = db.collection("events");
    const joinedEventsCollection = db.collection("joinedEvents");
    const usersCollection = db.collection("users");

    await usersCollection.createIndex({ email: 1 }, { unique: true });
    await eventsCollection.createIndex({ eventDate: 1 });
    await eventsCollection.createIndex({ creatorEmail: 1 });

    // A user can join the same event only once.
    try {
      await joinedEventsCollection.createIndex(
        { userEmail: 1, eventId: 1 },
        { unique: true }
      );
    } catch (error) {
      console.warn("Could not create joinedEvents unique index:", error.message);
    }

    app.get("/health", async (req, res) => {
      res.send({ status: "ok", database: "connected" });
    });

    // ---------- Better Auth (exposed at /api/auth) ----------
    const auth = betterAuth({
      database: mongodbAdapter(db),
      baseURL: publicBaseUrl,
      secret: process.env.BETTER_AUTH_SECRET || process.env.JWT_SECRET,
      emailAndPassword: {
        enabled: true,
      },
      trustedOrigins,
    });

    // Bridge Express requests to Better Auth's Web-standard handler.
    app.all(/^\/api\/auth/, async (req, res) => {
      try {
        const headers = {};
        Object.entries(req.headers).forEach(([key, value]) => {
          if (value === undefined) return;
          if (key === "host" || key === "content-length") return;
          headers[key] = Array.isArray(value) ? value.join(", ") : String(value);
        });

        const webRequest = new Request(
          new URL(req.originalUrl, publicBaseUrl).toString(),
          {
            method: req.method,
            headers,
            body: ["GET", "HEAD"].includes(req.method)
              ? undefined
              : JSON.stringify(req.body ?? {}),
          }
        );

        const response = await auth.handler(webRequest);

        res.status(response.status);
        response.headers.forEach((value, key) => res.setHeader(key, value));
        res.send(await response.text());
      } catch (err) {
        console.error("Auth handler error:", err);
        res.status(500).send({ message: "Authentication internal error" });
      }
    });

    // ---------- JWT auth routes ----------

    // Register a new account
    app.post("/auth/register", async (req, res) => {
      const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
      const email = normalizeEmail(req.body?.email);
      const password = typeof req.body?.password === "string" ? req.body.password : "";
      const photoURL =
        typeof req.body?.photoURL === "string" ? req.body.photoURL.trim() : "";

      if (!name) return res.status(400).send({ message: "name is required" });
      if (!isValidEmail(email)) {
        return res.status(400).send({ message: "A valid email is required" });
      }
      if (password.length < 8) {
        return res
          .status(400)
          .send({ message: "password must be at least 8 characters" });
      }

      const existing = await usersCollection.findOne({ email });
      if (existing) {
        return res
          .status(409)
          .send({ message: "An account with this email already exists" });
      }

      const passwordHash = await bcrypt.hash(password, 10);
      const user = {
        name,
        email,
        passwordHash,
        photoURL,
        createdAt: new Date(),
      };

      try {
        const result = await usersCollection.insertOne(user);
        const savedUser = { ...user, _id: result.insertedId };
        return res.status(201).send({
          token: createToken(savedUser),
          user: publicUser(savedUser),
        });
      } catch (error) {
        if (error.code === 11000) {
          return res
            .status(409)
            .send({ message: "An account with this email already exists" });
        }
        throw error;
      }
    });

    // Log in with email and password
    app.post("/auth/login", async (req, res) => {
      const email = normalizeEmail(req.body?.email);
      const password = typeof req.body?.password === "string" ? req.body.password : "";

      if (!isValidEmail(email) || !password) {
        return res.status(400).send({ message: "email and password are required" });
      }

      const user = await usersCollection.findOne({ email });
      const passwordMatches =
        user?.passwordHash && (await bcrypt.compare(password, user.passwordHash));

      if (!user || !passwordMatches) {
        return res.status(401).send({ message: "Invalid email or password" });
      }

      return res.send({
        token: createToken(user),
        user: publicUser(user),
      });
    });

    // Current user profile
    app.get("/auth/me", authenticate, async (req, res) => {
      const user = await usersCollection.findOne({ email: req.user.email });
      if (!user) return res.status(404).send({ message: "User not found" });
      res.send({ user: publicUser(user) });
    });

    // Update current user profile
    app.patch("/auth/me", authenticate, async (req, res) => {
      const updates = {};
      if (req.body?.name !== undefined) {
        if (!isNonEmptyString(req.body.name)) {
          return res.status(400).send({ message: "name cannot be empty" });
        }
        updates.name = req.body.name.trim();
      }
      if (req.body?.photoURL !== undefined) {
        if (typeof req.body.photoURL !== "string") {
          return res.status(400).send({ message: "photoURL must be a string" });
        }
        updates.photoURL = req.body.photoURL.trim();
      }
      if (!Object.keys(updates).length) {
        return res.status(400).send({ message: "Provide at least one field to update" });
      }

      updates.updatedAt = new Date();
      const result = await usersCollection.findOneAndUpdate(
        { email: req.user.email },
        { $set: updates },
        { returnDocument: "after" }
      );
      const updatedUser = result?.value ?? result;
      if (!updatedUser) return res.status(404).send({ message: "User not found" });
      res.send({ user: publicUser(updatedUser) });
    });

    // Change current user password
    app.patch("/auth/password", authenticate, async (req, res) => {
      const currentPassword =
        typeof req.body?.currentPassword === "string" ? req.body.currentPassword : "";
      const newPassword =
        typeof req.body?.newPassword === "string" ? req.body.newPassword : "";

      if (!currentPassword || newPassword.length < 8) {
        return res.status(400).send({
          message: "currentPassword is required and newPassword must be at least 8 characters",
        });
      }

      const user = await usersCollection.findOne({ email: req.user.email });
      if (!user?.passwordHash) {
        return res.status(404).send({ message: "User not found" });
      }

      const matches = await bcrypt.compare(currentPassword, user.passwordHash);
      if (!matches) {
        return res.status(401).send({ message: "Current password is incorrect" });
      }

      const passwordHash = await bcrypt.hash(newPassword, 10);
      await usersCollection.updateOne(
        { _id: user._id },
        { $set: { passwordHash, updatedAt: new Date() } }
      );
      res.send({ message: "Password updated" });
    });

    // 1. Create an event (logged-in users only)
    app.post("/events", authenticate, async (req, res) => {
      const { data, errors } = validateEventFields(req.body);
      if (errors.length) {
        return res.status(400).send({ message: errors[0], errors });
      }

      const event = {
        title: data.title,
        description: data.description || "",
        eventType: data.eventType,
        thumbnail: data.thumbnail || "",
        location: data.location || "",
        eventDate: data.eventDate,
        creatorEmail: req.user.email,
        createdAt: new Date(),
      };

      const result = await eventsCollection.insertOne(event);
      res.status(201).send({
        insertedId: result.insertedId,
        event: { ...event, _id: result.insertedId },
      });
    });

    // 2. Get upcoming events (public). Supports ?limit, ?eventType, ?search
    app.get("/events", async (req, res) => {
      const today = getToday();

      let limit = parseInt(req.query.limit, 10);
      if (!Number.isInteger(limit) || limit <= 0) limit = 0;

      const filters = [{ eventDate: { $gte: today } }];

      const eventType =
        typeof req.query.eventType === "string"
          ? req.query.eventType.trim()
          : "";
      if (eventType && eventType !== "all") {
        const normalizedEventType = normalizeEventType(eventType);
        if (!normalizedEventType) {
          return res.status(400).send({ message: "Invalid eventType filter" });
        }
        filters.push({ eventType: normalizedEventType });
      }

      const search =
        typeof req.query.search === "string" ? req.query.search.trim() : "";
      if (search) {
        const safeSearch = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const pattern = new RegExp(safeSearch, "i");
        filters.push({
          $or: [
            { title: pattern },
            { description: pattern },
            { location: pattern },
            { eventType: pattern },
          ],
        });
      }

      const query = eventsCollection
        .find({ $and: filters })
        .sort({ eventDate: 1 });
      if (limit) query.limit(limit);

      res.send(await query.toArray());
    });

    // 3. Get one event (public)
    app.get("/events/:id", async (req, res) => {
      const { id } = req.params;
      if (!ObjectId.isValid(id)) {
        return res.status(400).send({ message: "Invalid event id" });
      }

      const event = await eventsCollection.findOne({ _id: new ObjectId(id) });
      if (!event) {
        return res.status(404).send({ message: "Event not found" });
      }
      res.send(event);
    });

    // 4. Update an event (only the creator)
    app.put("/events/:id", authenticate, async (req, res) => {
      const { id } = req.params;
      if (!ObjectId.isValid(id)) {
        return res.status(400).send({ message: "Invalid event id" });
      }

      const event = await eventsCollection.findOne({ _id: new ObjectId(id) });
      if (!event) {
        return res.status(404).send({ message: "Event not found" });
      }

      if (normalizeEmail(event.creatorEmail) !== req.user.email) {
        return res
          .status(403)
          .send({ message: "You can only update your own events" });
      }

      const { data: updates, errors } = validateEventFields(req.body, {
        partial: true,
      });
      if (errors.length) {
        return res.status(400).send({ message: errors[0], errors });
      }
      if (!Object.keys(updates).length) {
        return res
          .status(400)
          .send({ message: "Provide at least one field to update" });
      }

      updates.updatedAt = new Date();

      const result = await eventsCollection.updateOne(
        { _id: event._id },
        { $set: updates }
      );
      res.send({ ...result, event: { ...event, ...updates } });
    });

    // 5. Delete an event (only the creator)
    app.delete("/events/:id", authenticate, async (req, res) => {
      const { id } = req.params;
      if (!ObjectId.isValid(id)) {
        return res.status(400).send({ message: "Invalid event id" });
      }

      const event = await eventsCollection.findOne({ _id: new ObjectId(id) });
      if (!event) {
        return res.status(404).send({ message: "Event not found" });
      }

      if (normalizeEmail(event.creatorEmail) !== req.user.email) {
        return res
          .status(403)
          .send({ message: "You can only delete your own events" });
      }

      const result = await eventsCollection.deleteOne({ _id: event._id });

      // Remove the joins of this event so it can't stay in anyone's list.
      const joinedResult = await joinedEventsCollection.deleteMany({
        eventId: event._id,
      });

      res.send({ ...result, deletedJoinedEvents: joinedResult.deletedCount });
    });

    // 6. Join an event (logged-in users only, once per event)
    app.post("/joined-events", authenticate, async (req, res) => {
      const eventId = req.body?.eventId;
      if (!eventId || !ObjectId.isValid(eventId)) {
        return res.status(400).send({ message: "A valid eventId is required" });
      }

      const event = await eventsCollection.findOne({
        _id: new ObjectId(eventId),
      });
      if (!event) {
        return res.status(404).send({ message: "Event not found" });
      }

      if (toDateKey(event.eventDate) < getToday()) {
        return res
          .status(400)
          .send({ message: "This event has already taken place" });
      }

      const userEmail = req.user.email;

      const alreadyJoined = await joinedEventsCollection.findOne({
        userEmail,
        eventId: event._id,
      });
      if (alreadyJoined) {
        return res
          .status(409)
          .send({ message: "You have already joined this event" });
      }

      const joinedEvent = {
        eventId: event._id,
        userEmail,
        user: {
          email: userEmail,
          name: req.body?.user?.name || req.body?.userName || "",
          image: req.body?.user?.image || req.body?.userImage || "",
        },
        event,
        eventDate: event.eventDate,
        joinedAt: new Date(),
      };

      try {
        const result = await joinedEventsCollection.insertOne(joinedEvent);
        res.status(201).send({
          ...result,
          joinedEvent: { ...joinedEvent, _id: result.insertedId },
        });
      } catch (error) {
        if (error.code === 11000) {
          return res
            .status(409)
            .send({ message: "You have already joined this event" });
        }
        throw error;
      }
    });

    // 7. Get the logged-in user's joined events, sorted by event date
    app.get("/joined-events", authenticate, async (req, res) => {
      const joined = await joinedEventsCollection
        .find({ userEmail: req.user.email })
        .toArray();

      const eventIds = joined.map((item) => item.eventId);
      const liveEvents = eventIds.length
        ? await eventsCollection.find({ _id: { $in: eventIds } }).toArray()
        : [];

      const liveEventsById = new Map(
        liveEvents.map((event) => [String(event._id), event])
      );

      const events = joined
        .map((item) => {
          const event = liveEventsById.get(String(item.eventId));
          if (!event) return null;
          return { ...event, joinedId: item._id, joinedAt: item.joinedAt };
        })
        .filter(Boolean)
        .sort((a, b) =>
          toDateKey(a.eventDate).localeCompare(toDateKey(b.eventDate))
        );

      res.send(events);
    });

    // 8. Get events created by the logged-in user
    app.get("/my-events", authenticate, async (req, res) => {
      const events = await eventsCollection
        .find({ creatorEmail: req.user.email })
        .sort({ eventDate: 1 })
        .toArray();

      res.send(events);
    });

    // Unknown routes
    app.use((req, res) => {
      res.status(404).send({ message: "Route not found" });
    });

    // Any other error
    app.use((error, req, res, next) => {
      console.error("Request failed:", error);

      if (error instanceof SyntaxError && error.status === 400) {
        return res.status(400).send({ message: "Invalid JSON body" });
      }

      const status = error.status || error.statusCode || 500;
      res.status(status).send({
        message: status === 500 ? "Internal server error" : error.message,
      });
    });

    app.listen(port, () => {
      console.log(`Server running on port ${port}`);
    });
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
}

run();