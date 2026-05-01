import Link from "next/link";

const SUMMARY_CARDS = [
  { label: "Best current strategy", value: "few_shot", detail: "0.6723 aggregate F1" },
  { label: "Completed evals", value: "3", detail: "zero-shot, few-shot, CoT" },
  { label: "Budget", value: "< $0.07", detail: "per 50-case strategy run" },
] as const;

export default function Home() {
  return (
    <main className="mx-auto w-full max-w-6xl px-6 py-8">
      <section className="mb-8">
        <p className="mb-2 text-sm font-medium uppercase tracking-wide text-gray-500">Clinical extraction eval harness</p>
        <h1 className="text-3xl font-semibold text-gray-950 dark:text-gray-50">HEALOSBENCH</h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-gray-600 dark:text-gray-300">
          Compare prompt strategies for structured clinical extraction across 50 synthetic transcripts, with per-field
          metrics, retry traces, hallucination flags, cache stats, and run costs.
        </p>
      </section>

      <section className="mb-8 grid gap-4 md:grid-cols-3">
        {SUMMARY_CARDS.map((card) => (
          <div key={card.label} className="rounded-lg border bg-white p-4 dark:bg-neutral-950">
            <div className="text-xs text-gray-500">{card.label}</div>
            <div className="mt-2 text-2xl font-semibold">{card.value}</div>
            <div className="mt-1 text-sm text-gray-600 dark:text-gray-300">{card.detail}</div>
          </div>
        ))}
      </section>

      <section className="grid gap-4 md:grid-cols-2">
        <Link href="/runs" className="rounded-lg border bg-white p-5 transition-colors hover:border-blue-400 dark:bg-neutral-950">
          <h2 className="text-lg font-semibold">Runs</h2>
          <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">
            Review every eval run, inspect case-level scores, and open retry traces with gold/prediction diffs.
          </p>
        </Link>
        <Link href="/compare" className="rounded-lg border bg-white p-5 transition-colors hover:border-green-400 dark:bg-neutral-950">
          <h2 className="text-lg font-semibold">Compare</h2>
          <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">
            Pick two runs and see field-level winners, aggregate deltas, and the worst case regressions.
          </p>
        </Link>
      </section>
    </main>
  );
}
