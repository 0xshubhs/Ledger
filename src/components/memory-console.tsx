"use client"

import { useCallback, useEffect, useRef, useState } from "react"

interface FactRow {
  id: number
  subject: string
  predicate: string
  object: string
  validFrom: number
  validTo: number
  sessionIndex: number
}

interface ProvenanceRow {
  messageId: number
  role: string
  content: string
  ts: number
  sessionIndex: number
}

interface QueryResponse {
  answer: string | null
  abstained: boolean
  reason?: string
  plan?: { subject: string; predicate: string; wantsHistory: boolean; entities: string[] }
  retrievalPath: string
  facts: FactRow[]
  provenance?: ProvenanceRow[]
  retrieveMs: number
}

interface Stats {
  healthy: boolean
  sessions?: number
  messages?: number
  facts?: number
  entities?: number
}

type LogLevel = "info" | "ok" | "warn" | "err"
interface LogLine {
  level: LogLevel
  text: string
  at: number
}

const LOG_COLOR: Record<LogLevel, string> = {
  info: "text-neutral-500",
  ok: "text-[#0A7B34]",
  warn: "text-[#B45309]",
  err: "text-[#0001FC]",
}

/**
 * A knowledge-update scenario in the shape LongMemEval tests: the user states a
 * preference, then five sessions later revises it. A vector store would hold
 * both statements as similar chunks with no way to say which is still true. Here
 * the revision closes the first fact and links SUPERSEDES to it, so current
 * truth and full history are two different queries over the same data.
 */
const SCENARIO = {
  userExternalId: "demo-user",
  sessions: [
    {
      sessionIndex: 0,
      startedAt: Date.UTC(2023, 4, 20, 2, 21),
      messages: [
        { role: "user" as const, content: "I switched my editor to dark mode, much better for late nights." },
        { role: "assistant" as const, content: "Noted — dark mode it is." },
      ],
      facts: [
        {
          subject: "user",
          predicate: "prefers_theme",
          object: "dark mode",
          entities: ["editor"],
          sourceMessageIndex: 0,
        },
      ],
    },
    {
      sessionIndex: 2,
      startedAt: Date.UTC(2023, 4, 24, 11, 5),
      messages: [
        { role: "user" as const, content: "Started the Helios migration this week, it's my main project now." },
      ],
      facts: [
        {
          subject: "user",
          predicate: "current_project",
          object: "Helios migration",
          entities: ["Helios"],
          sourceMessageIndex: 0,
        },
      ],
    },
    {
      sessionIndex: 5,
      startedAt: Date.UTC(2023, 4, 28, 14, 5),
      messages: [
        { role: "user" as const, content: "Actually I went back to light mode, dark strained my eyes." },
      ],
      facts: [
        {
          subject: "user",
          predicate: "prefers_theme",
          object: "light mode",
          entities: ["editor"],
          sourceMessageIndex: 0,
        },
      ],
    },
  ],
}

const PROBES = [
  { label: "current truth", subject: "user", predicate: "prefers_theme", history: false },
  { label: "full history", subject: "user", predicate: "prefers_theme", history: true },
  { label: "other session", subject: "user", predicate: "current_project", history: false },
  { label: "never stated", subject: "user", predicate: "favourite_airline", history: false },
]

function fmt(ts: number) {
  return new Date(ts).toISOString().slice(0, 16).replace("T", " ")
}

export function MemoryConsole() {
  const [stats, setStats] = useState<Stats | null>(null)
  const [log, setLog] = useState<LogLine[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [result, setResult] = useState<(QueryResponse & { probe: string }) | null>(null)
  const [seeded, setSeeded] = useState(false)
  const logRef = useRef<HTMLDivElement>(null)

  const append = useCallback((level: LogLevel, text: string) => {
    setLog((prev) => [...prev, { level, text, at: Date.now() }])
  }, [])

  /**
   * Reads graph-node state and pushes it into React when it arrives. setStats
   * runs in the promise continuation rather than in an effect body, so the
   * effect below only kicks off the request — it does not set state itself.
   */
  const refreshStats = useCallback(
    () =>
      fetch("/api/stats")
        .then((res) => res.json())
        .then((json: Stats) => setStats(json))
        .catch(() => setStats({ healthy: false })),
    []
  )

  useEffect(() => {
    const controller = new AbortController()
    fetch("/api/stats", { signal: controller.signal })
      .then((res) => res.json())
      .then((json: Stats) => setStats(json))
      .catch(() => {
        if (!controller.signal.aborted) setStats({ healthy: false })
      })
    return () => controller.abort()
  }, [])

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [log])

  async function post(path: string, body: unknown) {
    const res = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
    const json = await res.json()
    if (!res.ok) throw new Error(json.error ?? `${path} failed with ${res.status}`)
    return json
  }

  async function seed() {
    setBusy("seed")
    setResult(null)
    try {
      for (const session of SCENARIO.sessions) {
        const messages = session.messages.map((m, i) => ({
          ...m,
          ts: session.startedAt + i * 1000,
        }))
        // Facts are supplied directly so the demo runs without an API key. The
        // /api/ingest route calls Claude for extraction when they're omitted.
        const res = await post("/api/ingest", {
          userExternalId: SCENARIO.userExternalId,
          sessionIndex: session.sessionIndex,
          startedAt: session.startedAt,
          messages,
          facts: session.facts,
        })
        const verb = res.factsSuperseded > 0 ? "SUPERSEDED a prior fact" : "wrote new fact"
        append(
          res.factsSuperseded > 0 ? "warn" : "ok",
          `session ${session.sessionIndex} (${fmt(session.startedAt)}) — ${res.messagesWritten} msgs, ${verb}`
        )
      }
      setSeeded(true)
      await refreshStats()
      append("info", "memory ready — probe it below")
    } catch (error) {
      append("err", (error as Error).message)
    } finally {
      setBusy(null)
    }
  }

  async function probe(p: (typeof PROBES)[number]) {
    setBusy(p.label)
    try {
      const res: QueryResponse = await post("/api/query", {
        userExternalId: SCENARIO.userExternalId,
        subject: p.subject,
        predicate: p.predicate,
        history: p.history,
        // Skip synthesis so the demo shows the retrieved subgraph itself and
        // needs no API key. The answer layer runs on the same facts.
        retrieveOnly: true,
      })
      setResult({ ...res, probe: p.label })

      if (res.facts.length === 0) {
        append("warn", `${p.predicate} → 0 rows, abstained (${res.retrieveMs}ms)`)
      } else {
        append(
          "ok",
          `${p.predicate} → ${res.facts.length} fact(s) via ${res.retrievalPath} (${res.retrieveMs}ms)`
        )
      }
    } catch (error) {
      append("err", (error as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const nodeDown = stats && !stats.healthy

  return (
    <section id="console" className="border-t-2 border-black bg-white px-6 py-20 md:px-12">
      <div className="mx-auto max-w-6xl">
        <p className="mb-3 text-xs font-bold uppercase tracking-[0.35em] text-[#0001FC]">
          Live memory console
        </p>
        <h2 className="mb-4 text-3xl font-bold uppercase tracking-tight md:text-5xl">
          Change your mind.
          <br />
          Watch memory keep both answers.
        </h2>
        <p className="mb-10 max-w-2xl text-sm leading-relaxed text-neutral-600">
          Three sessions go into a real HydraDB graph-node. Session 5 contradicts session 0.
          Nothing is deleted — the old fact is closed and linked by SUPERSEDES, so
          &ldquo;what&rsquo;s true now&rdquo; and &ldquo;what changed&rdquo; are two reads of
          the same data. The last probe asks something never stated, and the honest answer
          is nothing at all.
        </p>

        {nodeDown && (
          <div className="mb-8 border-2 border-[#0001FC] bg-[#F1F1FF] p-4 text-sm">
            <span className="font-bold uppercase tracking-wider text-[#0001FC]">
              graph-node unreachable
            </span>
            <p className="mt-2 text-neutral-700">
              Start a local node (see README) and reload. This console talks to a real
              database; there is no offline fallback by design.
            </p>
          </div>
        )}

        <div className="mb-8 grid grid-cols-2 gap-px border-2 border-black bg-black md:grid-cols-5">
          {[
            { label: "node", value: stats ? (stats.healthy ? "ready" : "down") : "…" },
            { label: "sessions", value: stats?.sessions ?? "—" },
            { label: "messages", value: stats?.messages ?? "—" },
            { label: "facts", value: stats?.facts ?? "—" },
            { label: "entities", value: stats?.entities ?? "—" },
          ].map((tile) => (
            <div key={tile.label} className="bg-white p-4">
              <div className="text-[10px] font-bold uppercase tracking-[0.3em] text-neutral-500">
                {tile.label}
              </div>
              <div className="mt-1 text-2xl font-bold tabular-nums">{tile.value}</div>
            </div>
          ))}
        </div>

        <div className="mb-8 flex flex-wrap gap-3">
          <button
            onClick={seed}
            disabled={busy !== null}
            className="border-2 border-black bg-black px-5 py-3 text-xs font-bold uppercase tracking-[0.2em] text-white transition-colors hover:bg-neutral-800 disabled:opacity-40"
          >
            {busy === "seed" ? "ingesting…" : "1 · ingest 3 sessions"}
          </button>
          {PROBES.map((p) => (
            <button
              key={p.label}
              onClick={() => probe(p)}
              disabled={busy !== null || !seeded}
              className="border-2 border-[#0001FC] bg-white px-5 py-3 text-xs font-bold uppercase tracking-[0.2em] text-[#0001FC] transition-colors hover:bg-[#F1F1FF] disabled:opacity-40"
            >
              {busy === p.label ? "querying…" : p.label}
            </button>
          ))}
        </div>

        <div className="grid gap-px border-2 border-black bg-black lg:grid-cols-2">
          <div className="bg-white p-6">
            <div className="mb-4 flex items-baseline justify-between">
              <h3 className="text-xs font-bold uppercase tracking-[0.3em]">Retrieved subgraph</h3>
              {result && (
                <span className="text-xs font-bold tabular-nums text-[#0001FC]">
                  {result.retrieveMs}ms · {result.retrievalPath}
                </span>
              )}
            </div>

            {!result && (
              <p className="text-sm text-neutral-500">Ingest the sessions, then run a probe.</p>
            )}

            {result && result.facts.length === 0 && (
              <div className="border-2 border-[#B45309] bg-[#FFFBEB] p-4">
                <div className="font-bold uppercase tracking-wider text-[#B45309]">
                  Abstained
                </div>
                <p className="mt-2 text-xs text-neutral-700">
                  {result.reason ?? "Not found in memory"} — the MATCH returned zero rows, so
                  the request stops here. There is no nearest neighbour to fall back on.
                </p>
              </div>
            )}

            {result?.facts.map((fact) => {
              const current = fact.validTo === 0
              return (
                <div
                  key={fact.id}
                  className={`mb-3 border-2 p-4 ${
                    current ? "border-[#0001FC] bg-[#F6F6FF]" : "border-neutral-400 bg-neutral-50"
                  }`}
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-sm font-bold">
                      {fact.subject} · {fact.predicate} ={" "}
                      <span className={current ? "text-[#0001FC]" : "text-neutral-500"}>
                        {fact.object}
                      </span>
                    </span>
                    <span
                      className={`shrink-0 border px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.2em] ${
                        current
                          ? "border-[#0001FC] text-[#0001FC]"
                          : "border-neutral-400 text-neutral-500"
                      }`}
                    >
                      {current ? "current" : "superseded"}
                    </span>
                  </div>
                  <div className="mt-2 grid gap-1 text-[11px] text-neutral-600">
                    <span>valid_from {fmt(fact.validFrom)}</span>
                    <span>
                      valid_to {current ? "0 (still true)" : fmt(fact.validTo)} · session{" "}
                      {fact.sessionIndex}
                    </span>
                  </div>
                </div>
              )
            })}

            {result?.provenance && result.provenance.length > 0 && (
              <div className="mt-4 border-t-2 border-black pt-4">
                <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.3em] text-neutral-500">
                  why this answer — source turn
                </div>
                {result.provenance.map((p) => (
                  <blockquote
                    key={p.messageId}
                    className="border-l-4 border-[#0001FC] bg-neutral-50 px-3 py-2 text-xs italic text-neutral-700"
                  >
                    &ldquo;{p.content}&rdquo;
                    <span className="mt-1 block not-italic text-[10px] uppercase tracking-wider text-neutral-500">
                      {p.role} · session {p.sessionIndex} · {fmt(p.ts)}
                    </span>
                  </blockquote>
                ))}
              </div>
            )}
          </div>

          <div className="bg-white p-6">
            <h3 className="mb-4 text-xs font-bold uppercase tracking-[0.3em]">Trace</h3>
            <div
              ref={logRef}
              className="h-[26rem] overflow-y-auto border-2 border-black bg-neutral-50 p-3 text-[11px] leading-relaxed"
            >
              {log.length === 0 && <span className="text-neutral-400">waiting…</span>}
              {log.map((line, i) => (
                <div key={i} className={`${LOG_COLOR[line.level]} break-all`}>
                  <span className="text-neutral-400">
                    {new Date(line.at).toLocaleTimeString("en-GB", { hour12: false })}{" "}
                  </span>
                  {line.text}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
