-- Only roles explicitly added by Renobot are eligible for automatic removal.
CREATE TABLE "managed_supporter_role" (
    "discord_user_id" TEXT NOT NULL,
    "role_id" TEXT NOT NULL,
    "granted_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY ("discord_user_id", "role_id")
);