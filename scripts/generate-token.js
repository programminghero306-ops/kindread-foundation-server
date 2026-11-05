require("dotenv").config();
const jwt = require("jsonwebtoken");

const email = process.argv[2];
const name = process.argv[3] || "Test User";

if (!email) {
  console.error("Usage: node scripts/generate-token.js <email> [name]");
  process.exit(1);
}

if (!process.env.JWT_SECRET) {
  console.error("JWT_SECRET is missing from .env");
  process.exit(1);
}

const token = jwt.sign({ email, name }, process.env.JWT_SECRET, {
  expiresIn: "7d",
});

console.log(token);
