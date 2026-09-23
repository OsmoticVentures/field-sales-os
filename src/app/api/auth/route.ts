/**
 * PIN exchange. The only endpoint that mints a session cookie. Ported
 * unchanged from the NutriBiotic OS (portfolio/src/app/nutribiotic/api/auth/route.ts).
 *
 * A route handler, not a Server Action: cookies().set() needs a response to
 * attach Set-Cookie to, and rate limiting belongs on one explicit door.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  COOKIE,
  DEVICE_COOKIE,
  DEVICE_LIMIT,
  DEVICE_TTL,
  SESSION_TTL_SECONDS,
  LOCKOUT_MINUTES,
  checkPin,
  lockRemainingMs,
  mintDeviceToken,
  mintToken,
  registerFailure,
  registerSuccess,
  requestUserAgent,
} from "../../../lib/core/session";
import { deviceLabel, enrollDevice, trustedDeviceIdFrom } from "../../../lib/core/devices";

export async function POST(req: Request) {
  // Request-scoped APIs first, awaited directly in the handler: in Next 16
  // `cookies()` and `headers()` only resolve inside this request's async
  // chain, so the jar is taken here and handed down, never fetched by a
  // helper of its own.
  const jar = await cookies();
  const ua = await requestUserAgent();

  const lockMs = lockRemainingMs();
  if (lockMs > 0) {
    return NextResponse.json(
      { ok: false, error: "locked", message: `Too many attempts. Locked for about ${Math.ceil(lockMs / 60000)} more minutes.` },
      { status: 429 },
    );
  }

  if (!process.env.NB_PIN || !process.env.NB_SESSION_SECRET) {
    return NextResponse.json(
      { ok: false, error: "unconfigured", message: "NB_PIN and NB_SESSION_SECRET are not set." },
      { status: 503 },
    );
  }

  let pin = "";
  let remember = false;
  let surface = "";
  try {
    const body = (await req.json()) as { pin?: unknown; remember?: unknown; surface?: unknown };
    pin = typeof body.pin === "string" ? body.pin : "";
    remember = body.remember === true;
    surface = typeof body.surface === "string" ? body.surface.slice(0, 24) : "";
  } catch {
    return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  }

  if (!checkPin(pin)) {
    const { locked, left } = registerFailure();
    return NextResponse.json(
      {
        ok: false,
        error: "bad_pin",
        message: locked ? `Too many attempts. Locked for ${LOCKOUT_MINUTES} minutes.` : "Incorrect PIN.",
        attempts_left: left,
        locked,
      },
      { status: 401 },
    );
  }

  registerSuccess();
  const opts = {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/nb",
  };
  jar.set(COOKIE, await mintToken(), { ...opts, maxAge: SESSION_TTL_SECONDS });

  // Remembering this device: possession of the PIN authorizes it, so this is
  // the only code path that may mint one.
  let remembered: "already" | "ok" | "full" | "off" | "error" = "off";
  if (remember) {
    try {
      const existing = await trustedDeviceIdFrom(jar.get(DEVICE_COOKIE)?.value);
      if (existing) {
        jar.set(DEVICE_COOKIE, await mintDeviceToken(existing), { ...opts, maxAge: DEVICE_TTL });
        remembered = "already";
      } else {
        const id = await enrollDevice(deviceLabel(ua, surface), ua, DEVICE_LIMIT);
        if (id) {
          jar.set(DEVICE_COOKIE, await mintDeviceToken(id), { ...opts, maxAge: DEVICE_TTL });
          remembered = "ok";
        } else {
          remembered = "full";
        }
      }
    } catch {
      remembered = "error";
    }
  }

  return NextResponse.json({ ok: true, remembered, device_limit: DEVICE_LIMIT });
}

/** Sign out: clears the session and stops trusting this device. */
export async function DELETE() {
  const jar = await cookies();
  jar.delete({ name: COOKIE, path: "/nb" });
  jar.delete({ name: DEVICE_COOKIE, path: "/nb" });
  return NextResponse.json({ ok: true });
}
