/**
 * A plain skeleton, local to this feature: lib/core/ui.tsx (shared, not
 * edited by this port) has no PageSkeleton primitive yet.
 */
export default function Loading() {
  return (
    <div className="animate-pulse">
      <div className="mb-6 h-7 w-28 rounded bg-[#E2DFD5]" />
      <div className="mb-7 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-20 rounded-lg border border-[#E2DFD5] bg-white" />
        ))}
      </div>
      <div className="h-64 rounded-lg border border-[#E2DFD5] bg-white" />
    </div>
  );
}
