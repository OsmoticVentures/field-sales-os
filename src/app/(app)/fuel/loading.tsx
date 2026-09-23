export default function Loading() {
  return (
    <div className="flex w-full flex-col gap-4">
      <div className="h-9 w-24 animate-pulse rounded-md bg-[#EDEBE3]" />
      <div className="h-64 w-full animate-pulse rounded-md bg-[#EDEBE3]" />
      <div className="h-40 w-full animate-pulse rounded-md bg-[#EDEBE3]" />
    </div>
  );
}
