"use client";

import { useEffect, useState } from "react";
import type { QuotaResponse } from "@/app/api/quota/route";
import { jget } from "./api";

/**
 * Module-level cache: one fetch cycle shared across all consumers (QuotaView,
 * header gauge strip, etc.). The cache holds the latest response + promise
 * for an in-flight fetch, so multiple components calling this hook in the
 * same render cycle share one network request.
 */
let cachedData: QuotaResponse | null = null;
let cacheTime = 0;
let fetchPromise: Promise<QuotaResponse> | null = null;
const CACHE_TTL = 60_000; // 60 seconds

/**
 * Fetch quota data with module-level caching.
 */
async function fetchQuota(): Promise<QuotaResponse> {
  const now = Date.now();
  // Return cached data if it's fresh.
  if (cachedData && now - cacheTime < CACHE_TTL) {
    return cachedData;
  }
  // If a fetch is already in flight, reuse its promise.
  if (fetchPromise) {
    return fetchPromise;
  }

  fetchPromise = jget<QuotaResponse>("/api/quota").then((data) => {
    cachedData = data;
    cacheTime = now;
    fetchPromise = null;
    return data;
  }).catch((err) => {
    fetchPromise = null;
    throw err;
  });

  return fetchPromise;
}

/**
 * Hook for polling quota data every 60 seconds and on mount/focus.
 * Returns the latest data or null if not yet loaded.
 */
export function useQuota() {
  const [data, setData] = useState<QuotaResponse | null>(cachedData);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      const q = await fetchQuota();
      setData(q);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  };

  // Fetch on mount and when the tab regains focus.
  useEffect(() => {
    void load();
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  // Poll every 60 seconds.
  useEffect(() => {
    const iv = setInterval(() => void load(), 60_000);
    return () => clearInterval(iv);
  }, []);

  return { data, error };
}
