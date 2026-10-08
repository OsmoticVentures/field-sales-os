/**
 * Any other screen leaves the modal slot empty. Without this, a link taken
 * from inside the side panel (Log a visit, Outbound) would land on its screen
 * with the panel still standing over it.
 */
export default function ClearModal() {
  return null;
}
