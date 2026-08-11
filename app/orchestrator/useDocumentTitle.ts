"use client";

// Browser tab title for the app shell. The root layout's static metadata title
// is the landing page's marketing line, which every open Operator tab inherited
// - so a strip of them all read the same and told you nothing about which
// project or session each one was parked on.
//
// The varying part leads and the app name trails, because a browser truncates a
// tab title from the right: on a crowded strip the first few characters are all
// you get, and they should be the project.
//
// `needsYou` leads everything, because a banner you missed has to stay visible
// somewhere: a tab parked behind twelve others still reads "(3) ..." on the
// strip, and the same count goes to the dock icon (setAppBadge).
import { useEffect } from "react";
import { setAppBadge } from "./notifications";

const SUFFIX = "Operator";

export function useDocumentTitle(title: string | null | undefined, needsYou = 0) {
  useEffect(() => {
    const base = title ? `${title} - ${SUFFIX}` : SUFFIX;
    document.title = needsYou > 0 ? `(${needsYou}) ${base}` : base;
  }, [title, needsYou]);
  useEffect(() => { setAppBadge(needsYou); }, [needsYou]);
}
