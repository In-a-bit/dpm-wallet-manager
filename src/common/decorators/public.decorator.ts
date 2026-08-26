import { SetMetadata } from "@nestjs/common";

export const IS_PUBLIC_KEY = "dpmm:isPublic";

/**
 * Exempts a route from the app-wide API-key guard. Authentication is on by default, so a new
 * controller is guarded whether or not its author remembered to think about it.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
