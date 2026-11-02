// Imported first by the worker entry: loads .env locally (Render sets real env vars) and names the
// service for the logger before any other module creates it.
import "dotenv/config";

process.env.SERVICE_NAME ??= "worker";
