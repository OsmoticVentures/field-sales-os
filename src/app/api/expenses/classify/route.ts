/**
 * The "auto sorts" half of the expenses UI: look at one photo and suggest
 * what it is (odometer / receipt / bank-statement screenshot) and, where the
 * digits are legible, a best-effort reading of the fields a rep would type
 * next. Ported unchanged from the NutriBiotic OS
 * (portfolio/src/app/nutribiotic/api/expenses/classify/route.ts).
 *
 * A SUGGESTION ONLY. Every field lands in an editable input the rep confirms
 * or corrects before anything is filed; this route never writes to
 * Drive/Sheets. Not a write, so it takes no idempotency key: nothing here
 * creates a row, a repeat call just costs another model call.
 */
import Anthropic from "@anthropic-ai/sdk";
import { hasAccess } from "../../../../lib/core/devices";

export const runtime = "nodejs";
export const maxDuration = 30;

const client = process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;

const CLASSIFY_TOOL = {
  name: "classify_expense_photo",
  description: "Classify one field-expense photo and read only what is clearly legible.",
  input_schema: {
    type: "object" as const,
    properties: {
      photo_type: {
        type: "string",
        enum: ["odometer", "receipt", "statement"],
        description:
          "odometer: a car dashboard/odometer display. receipt: a paper store receipt. statement: a bank/card app screenshot listing multiple charges.",
      },
      odometer_reading: { type: ["string", "null"], description: "The total odometer number, digits only (a decimal is normal). Null if not an odometer photo or unreadable." },
      odometer_moment: {
        type: ["string", "null"],
        enum: ["start", "end", null],
        description: "The colourful EV/battery-style cluster is the start of a drive, the plain dark odometer screen is the end. Null if unsure.",
      },
      merchant: { type: ["string", "null"], description: "Receipt only: the merchant name exactly as printed. Null if not a receipt or unreadable." },
      amount: { type: ["string", "null"], description: "Receipt only: the total amount paid (not subtotal), digits only. Null if not a receipt or unreadable." },
      date: { type: ["string", "null"], description: "Receipt only: the date printed on the receipt, YYYY-MM-DD. Null if not printed or unreadable." },
      category: {
        type: ["string", "null"],
        enum: ["meals", "parking", "tolls", "fuel", "lodging", "supplies", "samples", "shipping", "other", null],
        description: "Receipt only: what kind of expense this is, read off the merchant/items, not guessed from context. Null if not a receipt or unclear.",
      },
      city: { type: ["string", "null"], description: "Receipt only, parking category only: the city printed in the merchant's address, if any. Null otherwise." },
      item_summary: {
        type: ["string", "null"],
        description:
          "Receipt only, meals category only: the food itself in 1-3 plain words read off the line items (e.g. 'burger', 'chia pudding'), never a business reason. Null if not a meal receipt or the items aren't legible.",
      },
      confidence: { type: "string", enum: ["high", "medium", "low"] },
    },
    required: ["photo_type", "confidence"],
  },
};

export async function POST(req: Request) {
  if (!(await hasAccess())) {
    return Response.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  }
  if (!client) {
    return Response.json({ ok: false, error: "ANTHROPIC_API_KEY is not configured." }, { status: 500 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return Response.json({ ok: false, error: "Expected multipart/form-data." }, { status: 400 });
  }
  const photo = form.get("photo");
  if (!(photo instanceof File) || photo.size === 0) {
    return Response.json({ ok: false, error: "No photo." }, { status: 400 });
  }

  const mimeType = photo.type || "image/jpeg";
  const bytes = await photo.arrayBuffer();
  const base64 = Buffer.from(bytes).toString("base64");

  try {
    const msg = await client.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 500,
      system:
        "You are sorting a field rep's expense photos, never reading a digit you are not sure of. " +
        "An unreadable field must come back null, never a plausible guess: this feeds a reimbursement " +
        "claim and an invented number is a fabricated record. Odometer photos: the total odometer, " +
        "never a trip meter. If a dashboard shows both a colourful screen and a plain digital readout " +
        "across two different moments, that distinction (start vs end) only matters if this single " +
        "photo makes it obvious, otherwise leave odometer_moment null and let the rep pick (the app " +
        "pairs two odometer photos by which reading is numerically lower, so this field is a hint, " +
        "not load-bearing). For a receipt, also read its category and, for a meal, what the food " +
        "actually was in a few words (item_summary) and, for parking, the city on the receipt (city), " +
        "these feed a fixed purpose template (\"Lunch, <item_summary>\" / \"Parking, <city>\"), never " +
        "a business reason you infer yourself.",
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mimeType as "image/jpeg", data: base64 } },
            { type: "text", text: "Classify this field-expense photo." },
          ],
        },
      ],
      tools: [CLASSIFY_TOOL],
      tool_choice: { type: "tool", name: "classify_expense_photo" },
    });
    const toolUse = msg.content.find((b) => b.type === "tool_use");
    if (!toolUse || toolUse.type !== "tool_use") {
      return Response.json({ ok: false, error: "Could not read that photo." }, { status: 422 });
    }
    return Response.json({ ok: true, suggestion: toolUse.input });
  } catch (err) {
    return Response.json({ ok: false, error: err instanceof Error ? err.message : "Classify failed." }, { status: 500 });
  }
}
