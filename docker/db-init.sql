-- pgvector is not a "trusted" extension, so the non-superuser app role cannot create it. Installing it
-- in template1 makes every database created later (dev, Prisma shadow DB, throwaway test DBs) have it.
\connect template1
CREATE EXTENSION IF NOT EXISTS vector;
\connect postgres
CREATE ROLE crm_app LOGIN PASSWORD 'crm_app' NOSUPERUSER CREATEDB;
CREATE DATABASE crm_dev OWNER crm_app;
