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
  TRUST_COOKIE,
  DEVICE_LIMIT,
  DEVICE_TTL,
  SESSION_TTL_SECONDS,
  LOCKOUT_MINUTES,
  mintDeviceToken,
  mintToken,
  readDeviceToken,
  requestUserAgent,
  setTrustStamp,
} from "../../../lib/core/session";
import { addressKey, lockState, recordFailure, recordSuccess } from "../../../lib/core/lockout";
import { deviceLabel, enrollDevice, trustedDeviceIdFrom } from "../../../lib/core/devices";
import { deviceUser, userByPin } from "../../../lib/core/user";
import { captureError } from "@/lib/core/errors";

export async function POST(req: Request) {
  // Request-scoped APIs first, awaited directly in the handler: in Next 16
  // `cookies()` and `headers()` only resolve inside this request's async
  // chain, so the jar is taken here and handed down, never fetched by a
  // helper of its own.
  const jar = await cookies();
  const ua = await requestUserAgent();

  const who = await addressKey(req.headers);
  const { lockedMs: lockMs } = await lockState(who);
  if (lockMs > 0) {
    return NextResponse.json(
      { ok: false, error: "locked", message: `Too many attempts. Locked for about ${Math.ceil(lockMs / 60000)} more minutes.` },
      { status: 429 },
    );
  }

  if (!process.env.NB_SESSION_SECRET) {
    return NextResponse.json(
      { ok: false, error: "unconfigured", message: "NB_SESSION_SECRET is not set." },
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

  let user;
  try {
    user = await userByPin(pin);
  } catch (caught) {
    captureError(caught, "/api/auth");
    return NextResponse.json({ ok: false, error: "unavailable", message: "Could not check the PIN. Try again." }, { status: 503 });
  }
  if (!user) {
    const { locked, left } = await recordFailure(who);
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

  await recordSuccess(who);
  const opts = {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/nb",
  };
  jar.set(COOKIE, await mintToken(user.id), { ...opts, maxAge: SESSION_TTL_SECONDS });

  /* A remembered-device cookie for the other rep must not outlive this
     sign-in: once the session lapsed, it would quietly hand this browser back
     to them. */
  const prior = await readDeviceToken(jar.get(DEVICE_COOKIE)?.value);
  if (prior && deviceUser(prior) !== user.id) {
    jar.delete({ name: DEVICE_COOKIE, path: "/nb" });
    jar.delete({ name: TRUST_COOKIE, path: "/nb" });
  }

  // Remembering this device: possession of the PIN authorizes it, so this is
  // the only code path that may mint one.
  let remembered: "already" | "ok" | "full" | "off" | "error" = "off";
  if (remember) {
    try {
      /* A device already remembered for THIS rep is refreshed; one remembered
         for the other rep is left alone and this rep gets a slot of their own. */
      const found = await trustedDeviceIdFrom(jar.get(DEVICE_COOKIE)?.value);
      const existing = found && deviceUser(found) === user.id ? found : null;
      if (existing) {
        jar.set(DEVICE_COOKIE, await mintDeviceToken(existing.split("~")[0], user.id), { ...opts, maxAge: DEVICE_TTL });
        remembered = "already";
        await setTrustStamp(existing);
      } else {
        const id = await enrollDevice(`${user.name} · ${deviceLabel(ua, surface)}`, ua, DEVICE_LIMIT, user.id);
        if (id) {
          jar.set(DEVICE_COOKIE, await mintDeviceToken(id, user.id), { ...opts, maxAge: DEVICE_TTL });
          remembered = "ok";
          await setTrustStamp(`${id}~${user.id}`);
        } else {
          remembered = "full";
        }
      }
    } catch {
      remembered = "error";
    }
  }

  return NextResponse.json({ ok: true, remembered, device_limit: DEVICE_LIMIT, user: { id: user.id, name: user.name } });
}

/** Sign out: clears the session and stops trusting this device. */
export async function DELETE() {
  const jar = await cookies();
  jar.delete({ name: COOKIE, path: "/nb" });
  jar.delete({ name: DEVICE_COOKIE, path: "/nb" });
  jar.delete({ name: TRUST_COOKIE, path: "/nb" });
  return NextResponse.json({ ok: true });
}
