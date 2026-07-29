import { none } from "eve/channels/auth";

import { aiSdkChannel } from "@/lib/ai-sdk-channel";

export default aiSdkChannel({
  auth: [none()],
});
