-- Trial items entered during setup (setup step 4): archiveTestProducts archives them before launch.
ALTER TABLE "RtProduct" ADD COLUMN "isTestData" BOOLEAN NOT NULL DEFAULT false;

-- An import started from the setup wizard as trial items: the products it creates are trial items.
ALTER TABLE "RtImportBatch" ADD COLUMN "isTestData" BOOLEAN NOT NULL DEFAULT false;
