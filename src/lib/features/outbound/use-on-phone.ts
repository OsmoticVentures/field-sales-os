"use client";

import { useSyncExternalStore } from "react";

/**
 * True on a phone or tablet (the ClientOS app on the iPhone, or a mobile
 * browser), where a compose link should open the Outlook app rather than
 * Outlook on the web. An iPad in desktop mode reports itself as a Mac, so a
 * touch screen on "Macintosh" counts too. The server render has no device,
 * so it renders the web link and the client swaps it on hydrate.
 */
function onPhone(): boolean {
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod|Android/i.test(ua) || (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1);
}

const noSubscribe = () => () => {};

export function useOnPhone(): boolean {
  return useSyncExternalStore(noSubscribe, onPhone, () => false);
}
