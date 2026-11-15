// Bar Games venue context for the React client (the game kit's useVenue). Off a box it stays
// null and nothing changes: watchVenue() never fires standalone and applyTheme() ignores it.

import { useVenue as kitUseVenue } from "@bargames/gamekit/client";
import type { VenueContext } from "@bargames/sdk/client";

export const useVenue = (): VenueContext | null => kitUseVenue(undefined);
