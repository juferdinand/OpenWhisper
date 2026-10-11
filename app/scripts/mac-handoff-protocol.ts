/** Identify the packet format declared by the trusted producer workflow. */
export function usesBundleBackedMacHandoffPacket(workflow: string): boolean {
  return workflow.includes("mac-update-handoff-input/successor.bundle") &&
    workflow.includes("mac-update-handoff-input/successor-source.json");
}
