"use strict";

// Finivex Zimbabwe mobile-money push backend.
//
// Required environment variables:
//   FINIVEX_API_KEY
//   FINIVEX_API_SECRET
//
// Optional:
//   PORT                 (default: 3000)
//   FINIVEX_BASE_URL     (default: https://gateway.finivex.online/api/pg)
//   FINIVEX_CALLBACK_URL (your public URL ending in /api/webhooks/finivex)
//   MERCHANT_NAME        (shown on merchant-side receipts)
//   FRONTEND_ORIGIN      (default: *, intentionally open for initial setup)
//
// Never put the Finivex API secret in frontend code or commit it to source control.

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { rateLimit } = require("express-rate-limit");

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const API_BASE_URL = (
  process.env.FINIVEX_BASE_URL || "https://gateway.finivex.online/api/pg"
).replace(/\/+$/, "");
const API_KEY = process.env.FINIVEX_API_KEY;
const API_SECRET = process.env.FINIVEX_API_SECRET;
const MERCHANT_NAME = process.env.MERCHANT_NAME || "Merchant";
const CALLBACK_URL = process.env.FINIVEX_CALLBACK_URL;

const MOBILE_MONEY_METHODS = new Set([
  "ECOCASH",
  "ONEMONEY",
  "INNBUCKS",
  "OMARI",
]);
const CURRENCIES = new Set(["USD", "ZWG"]);
const otpSessions = new Map();

app.disable("x-powered-by");
app.use(
  cors({
    origin: process.env.FRONTEND_ORIGIN
      ? process.env.FRONTEND_ORIGIN.trim()
      : "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "X-Request-Id"],
  }),
);
app.use(express.json({ limit: "32kb" }));
app.use(
  "/api",
  rateLimit({
    windowMs: 60 * 1000,
    limit: 90,
    standardHeaders: "draft-7",
    legacyHeaders: false,
  }),
);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function credentialsMissing() {
  const missing = [];
  if (!API_KEY) missing.push("FINIVEX_API_KEY");
  if (!API_SECRET) missing.push("FINIVEX_API_SECRET");
  return missing;
}

function sendMissingCredentials(res) {
  return res.status(503).json({
    success: false,
    error: "FINIVEX_CREDENTIALS_NOT_CONFIGURED",
    message: "Set the required Finivex credentials in the server environment.",
    missing: credentialsMissing(),
  });
}

function isReference(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 120 &&
    /^[A-Za-z0-9_-]+$/.test(value)
  );
}

function normalizeZimbabwePhone(value) {
  if (typeof value !== "string") return null;

  let phone = value.trim().replace(/[\s().-]/g, "");
  if (phone.startsWith("+")) phone = phone.slice(1);
  if (/^0\d{9}$/.test(phone)) phone = `263${phone.slice(1)}`;

  // The docs' example is 263771234567. The docs do not specify a
  // wallet-to-prefix map, so this validates the country/number format only.
  return /^263\d{9}$/.test(phone) ? phone : null;
}

function upstreamErrorStatus(status) {
  return Number.isInteger(status) && status >= 400 && status <= 599
    ? status
    : 502;
}

async function finivexRequest(path, options = {}) {
  const { useMerchantCredentials = true, ...fetchOptions } = options;
  const credentialHeaders = useMerchantCredentials
    ? {
        "X-API-Key": API_KEY,
        "X-API-Secret": API_SECRET,
      }
    : {};
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...fetchOptions,
    signal: AbortSignal.timeout(20_000),
    headers: {
      "Content-Type": "application/json",
      ...credentialHeaders,
      ...(options.headers || {}),
    },
  });

  const raw = await response.text();
  let body = raw;
  if (raw) {
    try {
      body = JSON.parse(raw);
    } catch {
      // Keep the upstream text intact when it is not JSON.
    }
  } else {
    body = null;
  }

  return {
    ok: response.ok && !(isObject(body) && body.success === false),
    status: response.status,
    body,
  };
}

function sendUpstreamError(res, result) {
  return res.status(upstreamErrorStatus(result.status)).json({
    success: false,
    error: "FINIVEX_REQUEST_FAILED",
    // Preserve the gateway's response body (including its exact error fields).
    finivexStatus: result.status,
    finivex: result.body,
  });
}

function sendNetworkError(res, error) {
  const timedOut = error && error.name === "TimeoutError";
  return res.status(502).json({
    success: false,
    error: timedOut ? "FINIVEX_TIMEOUT" : "FINIVEX_NETWORK_ERROR",
    message: error && error.message ? error.message : "Could not reach Finivex.",
  });
}

function validateConfiguredUrls() {
  if (!/^https:\/\//i.test(API_BASE_URL)) {
    throw new Error("FINIVEX_BASE_URL must use HTTPS.");
  }
  if (CALLBACK_URL) {
    const callback = new URL(CALLBACK_URL);
    if (
      callback.protocol !== "https:" &&
      callback.hostname !== "localhost" &&
      callback.hostname !== "127.0.0.1"
    ) {
      throw new Error("FINIVEX_CALLBACK_URL must use HTTPS.");
    }
  }
}

function chargeData(body) {
  return isObject(body) && isObject(body.data) ? body.data : {};
}

function makeReceipt(statusBody) {
  const data = chargeData(statusBody);
  if (data.status !== "COMPLETED") return null;

  return {
    // This is a merchant-side receipt reference, not a Finivex receipt number.
    receiptReference: data.reference,
    merchantName: MERCHANT_NAME,
    transactionReference: data.reference,
    providerReference: data.providerReference || null,
    paymentMethod: data.paymentMethod || null,
    amount: data.amount ?? null,
    currency: data.currency || null,
    status: "COMPLETED",
    statusDescription: data.statusDescription || "Payment successful",
    processedAt: data.processedAt || null,
    issuedAt: new Date().toISOString(),
  };
}

async function getChargeStatus(reference) {
  return finivexRequest(`/v1/charges/${encodeURIComponent(reference)}`, {
    method: "GET",
  });
}

async function getActiveMethods() {
  return finivexRequest("/v1/payments/active-methods", { method: "GET" });
}

app.get("/health", (_req, res) => {
  res.json({ success: true, service: "finivex-push-backend" });
});

// Lets the frontend display the methods enabled for this merchant account.
app.get("/api/payment-methods", async (_req, res) => {
  if (credentialsMissing().length) return sendMissingCredentials(res);

  try {
    const result = await getActiveMethods();
    if (!result.ok) return sendUpstreamError(res, result);
    return res.status(result.status).json({
      success: true,
      finivex: result.body,
    });
  } catch (error) {
    return sendNetworkError(res, error);
  }
});

// Creates a short-lived session on the backend, then initiates the push charge.
// Request JSON: { reference, paymentMethod, customerPhone, amount, currency, description? }
app.post("/api/payments/push", async (req, res) => {
  if (credentialsMissing().length) return sendMissingCredentials(res);

  const reference = req.body && req.body.reference;
  const paymentMethod =
    typeof req.body?.paymentMethod === "string"
      ? req.body.paymentMethod.trim().toUpperCase()
      : "";
  const customerPhone = normalizeZimbabwePhone(req.body?.customerPhone);
  const amount = req.body?.amount;
  const currency =
    typeof req.body?.currency === "string"
      ? req.body.currency.trim().toUpperCase()
      : "";
  const description = req.body?.description;

  if (!isReference(reference)) {
    return res.status(400).json({
      success: false,
      error: "INVALID_REFERENCE",
      message: "reference is required and may contain only letters, numbers, _ or -.",
    });
  }
  if (!MOBILE_MONEY_METHODS.has(paymentMethod)) {
    return res.status(400).json({
      success: false,
      error: "UNSUPPORTED_MOBILE_MONEY_METHOD",
      message: "Use one of the documented mobile-money methods.",
      supportedMethods: [...MOBILE_MONEY_METHODS],
    });
  }
  if (!customerPhone) {
    return res.status(400).json({
      success: false,
      error: "INVALID_PHONE",
      message:
        "Use a Zimbabwe mobile number in the documented international format, for example 263771234567.",
    });
  }
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({
      success: false,
      error: "INVALID_AMOUNT",
      message: "amount must be a positive number.",
    });
  }
  if (!CURRENCIES.has(currency)) {
    return res.status(400).json({
      success: false,
      error: "INVALID_CURRENCY",
      message: "currency must be USD or ZWG.",
    });
  }
  if (description !== undefined && typeof description !== "string") {
    return res.status(400).json({
      success: false,
      error: "INVALID_DESCRIPTION",
      message: "description must be a string when supplied.",
    });
  }
  if (CALLBACK_URL && !URL.canParse(CALLBACK_URL)) {
    return res.status(500).json({
      success: false,
      error: "INVALID_CALLBACK_URL",
      message: "FINIVEX_CALLBACK_URL is not a valid URL.",
    });
  }

  try {
    // The merchant-specific active-methods endpoint is the source of truth.
    const methodsResult = await getActiveMethods();
    if (!methodsResult.ok) return sendUpstreamError(res, methodsResult);

    const activeMethods = isObject(methodsResult.body)
      ? methodsResult.body.data
      : undefined;
    if (
      Array.isArray(activeMethods) &&
      !activeMethods.includes(paymentMethod)
    ) {
      return res.status(409).json({
        success: false,
        error: "PAYMENT_METHOD_NOT_ENABLED",
        message: `${paymentMethod} is not listed as active for this merchant account.`,
        activeMethods,
        finivex: methodsResult.body,
      });
    }
    if (!Array.isArray(activeMethods)) {
      return res.status(502).json({
        success: false,
        error: "UNEXPECTED_ACTIVE_METHODS_RESPONSE",
        message: "Finivex did not return the documented active-methods list.",
        finivex: methodsResult.body,
      });
    }

    // Finivex requires a widget session bound to the same transaction,
    // amount, and currency that are used for the charge.
    const sessionResult = await finivexRequest("/v1/payments/widget-session", {
      method: "POST",
      body: JSON.stringify({
        transactionId: reference,
        amount,
        currency,
      }),
    });
    if (!sessionResult.ok) return sendUpstreamError(res, sessionResult);

    const sessionToken = chargeData(sessionResult.body).sessionToken;
    if (typeof sessionToken !== "string" || !sessionToken) {
      return res.status(502).json({
        success: false,
        error: "SESSION_TOKEN_MISSING",
        message: "Finivex did not return data.sessionToken.",
        finivex: sessionResult.body,
      });
    }

    const chargeBody = {
      reference,
      paymentMethod,
      customerPhone,
      amount,
      currency,
    };
    if (description) chargeBody.description = description;
    if (CALLBACK_URL) chargeBody.callbackUrl = CALLBACK_URL;

    const chargeStartedAt = Date.now();
    const chargeResult = await finivexRequest("/v1/charges", {
      method: "POST",
      useMerchantCredentials: false,
      headers: { Authorization: `Bearer ${sessionToken}` },
      body: JSON.stringify(chargeBody),
    });
    if (!chargeResult.ok) return sendUpstreamError(res, chargeResult);

    const initiatedCharge = chargeData(chargeResult.body);
    if (
      paymentMethod === "OMARI" &&
      initiatedCharge.status === "PROCESSING" &&
      typeof initiatedCharge.reference === "string"
    ) {
      const now = Date.now();
      for (const [savedReference, savedSession] of otpSessions) {
        if (savedSession.expiresAt <= now) otpSessions.delete(savedReference);
      }
      otpSessions.set(reference, {
        sessionToken,
        expiresAt: chargeStartedAt + 5 * 60 * 1000,
      });
    }

    let receipt = null;
    let receiptVerificationPending = false;
    let receiptVerificationError = null;
    if (initiatedCharge.status === "COMPLETED") {
      const verification = await getChargeStatus(reference);
      if (verification.ok) {
        receipt = makeReceipt(verification.body);
      } else {
        // The charge response is still returned; never issue an unverified receipt.
        receiptVerificationPending = true;
        receiptVerificationError = {
          finivexStatus: verification.status,
          finivex: verification.body,
        };
      }
    }

    return res.status(chargeResult.status).json({
      success: true,
      finivex: chargeResult.body,
      receipt,
      receiptVerificationPending,
      receiptVerificationError,
      otpRequired:
        paymentMethod === "OMARI" && initiatedCharge.status === "PROCESSING",
      otpSubmissionUrl:
        paymentMethod === "OMARI" && initiatedCharge.status === "PROCESSING"
          ? `/api/payments/${encodeURIComponent(reference)}/otp`
          : null,
      receiptStatusUrl: `/api/receipts/${encodeURIComponent(reference)}`,
    });
  } catch (error) {
    return sendNetworkError(res, error);
  }
});

// Omari is an OTP rail, not a push-prompt rail. The docs require the same
// short-lived session token used to create the charge and an OTP-only body.
app.post("/api/payments/:reference/otp", async (req, res) => {
  if (credentialsMissing().length) return sendMissingCredentials(res);
  const reference = req.params.reference;
  if (!isReference(reference)) {
    return res.status(400).json({
      success: false,
      error: "INVALID_REFERENCE",
      message: "Invalid transaction reference.",
    });
  }

  const otp = req.body?.otp;
  if (typeof otp !== "string" || !/^\d{1,12}$/.test(otp)) {
    return res.status(400).json({
      success: false,
      error: "INVALID_OTP",
      message: "otp must be supplied as digits.",
    });
  }

  const savedSession = otpSessions.get(reference);
  if (!savedSession || savedSession.expiresAt <= Date.now()) {
    otpSessions.delete(reference);
    return res.status(410).json({
      success: false,
      error: "OTP_SESSION_EXPIRED_OR_UNKNOWN",
      message:
        "No live Omari session was found. The docs require submitting the OTP within five minutes of initiating the charge.",
    });
  }

  try {
    const result = await finivexRequest(
      `/v1/charges/${encodeURIComponent(reference)}/otp`,
      {
        method: "POST",
        useMerchantCredentials: false,
        headers: {
          Authorization: `Bearer ${savedSession.sessionToken}`,
        },
        body: JSON.stringify({ otp }),
      },
    );
    if (!result.ok) {
      otpSessions.delete(reference);
      return sendUpstreamError(res, result);
    }

    const otpResult = chargeData(result.body);
    const paymentFailed =
      otpResult.success === false || otpResult.status === "FAILED";
    otpSessions.delete(reference);

    let receipt = null;
    let receiptVerificationError = null;
    if (!paymentFailed && otpResult.status === "COMPLETED") {
      const verification = await getChargeStatus(reference);
      if (verification.ok) {
        receipt = makeReceipt(verification.body);
      } else {
        receiptVerificationError = {
          finivexStatus: verification.status,
          finivex: verification.body,
        };
      }
    }

    return res.status(result.status).json({
      success: !paymentFailed,
      finivex: result.body,
      receipt,
      receiptVerificationError,
      receiptStatusUrl: `/api/receipts/${encodeURIComponent(reference)}`,
    });
  } catch (error) {
    return sendNetworkError(res, error);
  }
});

// Poll Finivex for the authoritative status; attach a receipt only if completed.
app.get("/api/payments/:reference", async (req, res) => {
  if (credentialsMissing().length) return sendMissingCredentials(res);
  if (!isReference(req.params.reference)) {
    return res.status(400).json({
      success: false,
      error: "INVALID_REFERENCE",
      message: "Invalid transaction reference.",
    });
  }

  try {
    const result = await getChargeStatus(req.params.reference);
    if (!result.ok) return sendUpstreamError(res, result);
    return res.status(result.status).json({
      success: true,
      finivex: result.body,
      receipt: makeReceipt(result.body),
    });
  } catch (error) {
    return sendNetworkError(res, error);
  }
});

// A receipt is generated only after a fresh status lookup says COMPLETED.
app.get("/api/receipts/:reference", async (req, res) => {
  if (credentialsMissing().length) return sendMissingCredentials(res);
  if (!isReference(req.params.reference)) {
    return res.status(400).json({
      success: false,
      error: "INVALID_REFERENCE",
      message: "Invalid transaction reference.",
    });
  }

  try {
    const result = await getChargeStatus(req.params.reference);
    if (!result.ok) return sendUpstreamError(res, result);

    const receipt = makeReceipt(result.body);
    if (!receipt) {
      return res.status(409).json({
        success: false,
        error: "PAYMENT_NOT_COMPLETED",
        message: "A receipt is available only after Finivex confirms COMPLETED.",
        finivex: result.body,
      });
    }
    return res.json({ success: true, receipt, finivex: result.body });
  } catch (error) {
    return sendNetworkError(res, error);
  }
});

// Finivex webhook payloads in the docs include transactionId and status.
// The payload is not trusted for issuing receipts: this endpoint rechecks status
// directly with Finivex before returning a receipt.
app.post("/api/webhooks/finivex", async (req, res) => {
  if (credentialsMissing().length) return sendMissingCredentials(res);

  const reference = req.body?.transactionId || req.body?.reference;
  if (!isReference(reference)) {
    return res.status(400).json({
      success: false,
      error: "INVALID_WEBHOOK_REFERENCE",
      message: "Webhook must include a valid transactionId or reference.",
    });
  }

  try {
    const result = await getChargeStatus(reference);
    if (!result.ok) return sendUpstreamError(res, result);

    return res.json({
      success: true,
      received: true,
      finivex: result.body,
      receipt: makeReceipt(result.body),
    });
  } catch (error) {
    return sendNetworkError(res, error);
  }
});

app.use((error, _req, res, _next) => {
  if (error && error.type === "entity.parse.failed") {
    return res.status(400).json({
      success: false,
      error: "INVALID_JSON",
      message: "Request body must be valid JSON.",
    });
  }
  return res.status(500).json({
    success: false,
    error: "INTERNAL_SERVER_ERROR",
    message: "The backend could not process the request.",
  });
});

try {
  validateConfiguredUrls();
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Finivex push backend listening on port ${PORT}`);
    if (credentialsMissing().length) {
      console.warn(
        `Missing required environment variables: ${credentialsMissing().join(", ")}`,
      );
    }
  });
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
