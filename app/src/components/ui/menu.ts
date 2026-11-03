// The classes the menu parts share (Menu*.vue). A highlighted item is the one the arrow keys or the pointer are on.
export const MENU_ITEM =
  'flex w-full cursor-default items-center justify-between gap-3 rounded-sm px-2 py-1 text-left outline-none select-none data-[highlighted]:bg-panel-2 data-[disabled]:opacity-50';
export const MENU_CONTENT =
  'z-30 max-h-[min(80vh,var(--reka-dropdown-menu-content-available-height))] min-w-[160px] overflow-y-auto rounded-md border border-border bg-panel p-1.5 shadow-popover';
