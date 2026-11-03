require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion } = require("mongodb");

const app = express();
const port = process.env.PORT || 5000;
const uri = process.env.MONGODB_URI;

if (!uri) {
  console.error("MONGODB_URI is missing. Add it to your .env file.");
  process.exit(1);
}

app.use(cors());
app.use(express.json());

const client = new MongoClient(uri, {
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
  } catch (error) {
    console.error("MongoDB connection failed:", error.message);
    process.exit(1);
  }
}

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

run();