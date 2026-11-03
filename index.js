require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

const app = express();
const port = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

const client = new MongoClient(process.env.MONGODB_URI, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

app.get("/", (req, res) => {
  res.send("Kindred Foundation server is running");
});

async function run() {
  try {
    await client.connect();
    console.log("Connected to MongoDB");

    const db = client.db("kindredDB");
    const eventsCollection = db.collection("events");

    // 1. Create an event
    app.post("/events", async (req, res) => {
      const event = req.body;
      event.createdAt = new Date();
      const result = await eventsCollection.insertOne(event);
      res.send(result);
    });

    // 2. Get upcoming events
    app.get("/events", async (req, res) => {
      const today = new Date().toISOString().split("T")[0];
      const limit = parseInt(req.query.limit) || 0;

      const events = await eventsCollection
        .find({ eventDate: { $gte: today } })
        .sort({ eventDate: 1 })
        .limit(limit)
        .toArray();

      res.send(events);
    });

    // 3. Get one event
    app.get("/events/:id", async (req, res) => {
      const id = req.params.id;
      const event = await eventsCollection.findOne({ _id: new ObjectId(id) });
      res.send(event);
    });
  } catch (error) {
    console.error("MongoDB connection failed:", error);
  }
}
run();

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});