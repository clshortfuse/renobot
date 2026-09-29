-- Source addresses are evidence for later investigation, never webhook authentication.
ALTER TABLE "kofi_event" ADD COLUMN "source_ip" TEXT;
ALTER TABLE "kofi_event" ADD COLUMN "source_port" INTEGER;
ALTER TABLE "kofi_event" ADD COLUMN "source_via_proxy" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "kofi_event" ADD COLUMN "peer_ip" TEXT;
ALTER TABLE "kofi_event" ADD COLUMN "peer_port" INTEGER;