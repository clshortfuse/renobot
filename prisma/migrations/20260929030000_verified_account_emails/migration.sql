CREATE TABLE "account_email" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "account_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "verified_by" TEXT NOT NULL,
    "verified_at" DATETIME NOT NULL,
    CONSTRAINT "account_email_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "account_email_email_key" ON "account_email"("email");
CREATE INDEX "account_email_account_id_idx" ON "account_email"("account_id");
ALTER TABLE "kofi_event" ADD COLUMN "supporter_email" TEXT;
CREATE INDEX "kofi_event_email_discord_id_idx" ON "kofi_event"("supporter_email", "supporter_discord_user_id");