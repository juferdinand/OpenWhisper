/** KWin's dock role keeps pointer delivery while refusing click activation.
 * On KWin 5.27 it stacks above ordinary windows, below active fullscreen windows.
 * The layer-shell namespace is a presentation hint; the application ID is unchanged.
 */
export function kdeRecordingSurfaceNamespace(desktop: string | undefined): "dock" | undefined {
  return desktop?.split(":").some((name) => name.toUpperCase() === "KDE") ? "dock" : undefined;
}
