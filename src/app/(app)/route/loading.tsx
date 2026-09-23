export default function Loading() {
  return (
    <div className="flex w-full flex-col gap-3">
      <div className="h-9 w-64 animate-pulse rounded-md bg-[#EDEBE3]" />
      <div className="h-20 w-full animate-pulse rounded-md bg-[#EDEBE3]" />
      <div className="h-40 w-full animate-pulse rounded-md bg-[#EDEBE3]" />
    </div>
  );
}
