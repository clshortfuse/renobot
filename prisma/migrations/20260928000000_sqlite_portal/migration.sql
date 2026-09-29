-- Initial SQLite schema for the single-instance portal.
CREATE TABLE "account" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "discord_user_id" TEXT NOT NULL,
    "last_known_username" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    "last_login_at" DATETIME NOT NULL
);

CREATE TABLE "kofi_integration" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "account_id" TEXT NOT NULL,
    "endpoint_id" TEXT NOT NULL,
    "verification_token_ciphertext" TEXT NOT NULL,
    "minimum_amount" DECIMAL NOT NULL,
    "currency" TEXT NOT NULL,
    "forward_url_ciphertext" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "last_test_at" DATETIME,
    "last_webhook_at" DATETIME,
    "last_forwarded_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "kofi_integration_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "kofi_event" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "integration_id" TEXT NOT NULL,
    "message_id" TEXT NOT NULL,
    "transaction_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "supporter_discord_user_id" TEXT,
    "amount" DECIMAL NOT NULL,
    "currency" TEXT NOT NULL,
    "subscription_payment" BOOLEAN NOT NULL,
    "first_subscription_payment" BOOLEAN NOT NULL,
    "tier_name" TEXT,
    "occurred_at" DATETIME NOT NULL,
    "received_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "outcome" TEXT NOT NULL,
    "entitlement_expires_at" DATETIME,
    CONSTRAINT "kofi_event_integration_id_fkey" FOREIGN KEY ("integration_id") REFERENCES "kofi_integration" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "kofi_entitlement" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "integration_id" TEXT NOT NULL,
    "discord_user_id" TEXT NOT NULL,
    "last_event_id" TEXT NOT NULL,
    "last_payment_at" DATETIME NOT NULL,
    "expires_at" DATETIME NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "kofi_entitlement_integration_id_fkey" FOREIGN KEY ("integration_id") REFERENCES "kofi_integration" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "kofi_entitlement_last_event_id_integration_id_fkey" FOREIGN KEY ("last_event_id", "integration_id") REFERENCES "kofi_event" ("id", "integration_id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "supporter_role_sync" (
    "discord_user_id" TEXT NOT NULL PRIMARY KEY,
    "next_attempt_at" DATETIME NOT NULL,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "last_error_code" TEXT,
    "updated_at" DATETIME NOT NULL
);

CREATE TABLE "kofi_forward_delivery" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "event_id" TEXT NOT NULL,
    "body_ciphertext" TEXT,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" DATETIME NOT NULL,
    "last_http_status" INTEGER,
    "last_error_code" TEXT,
    "delivered_at" DATETIME,
    "discarded_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "kofi_forward_delivery_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "kofi_event" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "account_discord_user_id_key" ON "account"("discord_user_id");
CREATE UNIQUE INDEX "kofi_integration_account_id_key" ON "kofi_integration"("account_id");
CREATE UNIQUE INDEX "kofi_integration_endpoint_id_key" ON "kofi_integration"("endpoint_id");
CREATE INDEX "kofi_event_supporter_discord_user_id_idx" ON "kofi_event"("supporter_discord_user_id");
CREATE INDEX "kofi_event_received_at_idx" ON "kofi_event"("received_at");
CREATE UNIQUE INDEX "kofi_event_integration_id_message_id_key" ON "kofi_event"("integration_id", "message_id");
CREATE UNIQUE INDEX "kofi_event_id_integration_id_key" ON "kofi_event"("id", "integration_id");
CREATE INDEX "kofi_entitlement_discord_user_id_expires_at_idx" ON "kofi_entitlement"("discord_user_id", "expires_at");
CREATE INDEX "kofi_entitlement_expires_at_idx" ON "kofi_entitlement"("expires_at");
CREATE UNIQUE INDEX "kofi_entitlement_integration_id_discord_user_id_key" ON "kofi_entitlement"("integration_id", "discord_user_id");
CREATE INDEX "supporter_role_sync_next_attempt_at_idx" ON "supporter_role_sync"("next_attempt_at");
CREATE UNIQUE INDEX "kofi_forward_delivery_event_id_key" ON "kofi_forward_delivery"("event_id");
CREATE INDEX "kofi_forward_delivery_next_attempt_at_idx" ON "kofi_forward_delivery"("next_attempt_at");
