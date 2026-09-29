CREATE TABLE "early_access_balance" (
    "discord_user_id" TEXT NOT NULL PRIMARY KEY,
    "total_amount" DECIMAL NOT NULL DEFAULT 0,
    "credited_months" INTEGER NOT NULL DEFAULT 0,
    "expires_at" DATETIME
);

CREATE TABLE "early_access_credit" (
    "event_id" TEXT NOT NULL PRIMARY KEY,
    "discord_user_id" TEXT NOT NULL,
    "credited_at" DATETIME NOT NULL
);
CREATE INDEX "early_access_credit_discord_user_id_credited_at_event_id_idx" ON "early_access_credit"("discord_user_id", "credited_at", "event_id");

CREATE TABLE "early_access_period" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "discord_user_id" TEXT NOT NULL,
    "started_at" DATETIME NOT NULL,
    "expires_at" DATETIME NOT NULL,
    "months" INTEGER NOT NULL
);
CREATE INDEX "early_access_period_discord_user_id_started_at_idx" ON "early_access_period"("discord_user_id", "started_at");

CREATE TABLE "early_access_role_sync" (
    "discord_user_id" TEXT NOT NULL PRIMARY KEY,
    "next_attempt_at" DATETIME NOT NULL,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "last_error_code" TEXT,
    "updated_at" DATETIME NOT NULL
);
CREATE INDEX "early_access_role_sync_next_attempt_at_idx" ON "early_access_role_sync"("next_attempt_at");