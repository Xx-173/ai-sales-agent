import { APP_BASE } from '../../utils/url';

interface LogoLoadingProps {
  /** Show full animated logo with wordmark */
  full?: boolean;
  /** Size of the icon-only variant (default 64) */
  size?: number;
  /** Optional label below the logo */
  label?: string;
}

/**
 * Animated loading screen with the SalesClaw logo.
 * - `full` mode: shows the product icon and wordmark
 * - default: shows the icon with a subtle pulse animation
 */
export function LogoLoading({ full, size = 64, label }: LogoLoadingProps) {
  if (full) {
    return (
      <div className="min-h-screen bg-background text-foreground flex flex-col items-center justify-center">
        <img
          src={`${APP_BASE}icons/icon-192.png`}
          alt="SalesClaw"
          className="size-20 rounded-3xl animate-pulse"
        />
        <span className="mt-4 text-2xl font-semibold tracking-tight">SalesClaw</span>
        {label && <p className="mt-6 text-sm text-muted-foreground">{label}</p>}
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center gap-4">
      <img
        src={`${APP_BASE}icons/icon-192.png`}
        alt="SalesClaw"
        className="animate-pulse rounded-2xl"
        style={{ width: size, height: size }}
      />
      {label && <p className="text-sm text-muted-foreground">{label}</p>}
    </div>
  );
}
