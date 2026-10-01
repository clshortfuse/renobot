CREATE TABLE "email_verification" (
    "token_hash" TEXT NOT NULL PRIMARY KEY,
    "account_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL,
    "expires_at" DATETIME NOT NULL,
    "consumed_at" DATETIME,
    CONSTRAINT "email_verification_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "email_verification_account_created_idx" ON "email_verification"("account_id", "created_at");
CREATE INDEX "email_verification_email_created_idx" ON "email_verification"("email", "created_at");