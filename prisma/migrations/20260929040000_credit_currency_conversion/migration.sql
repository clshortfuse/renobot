ALTER TABLE "early_access_credit" ADD COLUMN "converted_amount" DECIMAL;
ALTER TABLE "early_access_credit" ADD COLUMN "target_currency" TEXT;
ALTER TABLE "early_access_credit" ADD COLUMN "exchange_rate" DECIMAL;
ALTER TABLE "early_access_credit" ADD COLUMN "rate_date" TEXT;