"use client";

// Browser tab title for the app shell. The root layout's static metadata title
// is the landing page's marketing line, which every open Operator tab inherited
// - so a strip of them all read the same and told you nothing about which
// project or session each one was parked on.
//
// The varying part leads and the app name trails, because a browser truncates a
// tab title from the right: on a crowded strip the first few characters are all
// you get, and they should be the project.
import { useEffect } from "react";

const SUFFIX = "Operator";

export function useDocumentTitle(title: string | null | undefined) {
  useEffect(() => {
    document.title = title ? `${title} - ${SUFFIX}` : SUFFIX;
  }, [title]);
}
