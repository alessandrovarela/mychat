import type { ReactElement } from "react";
import { ButtonLink, Notice } from "./components/index.js";
import { useLocale } from "./locale.js";
import { useNavigation } from "./navigation.js";
import { LOGIN_ADDRESS } from "./screens/login.js";

/** The only action useful after a private read was refused for want of a session. */
function SignInLink(): ReactElement {
  const { t } = useLocale();
  const { follow } = useNavigation();

  return (
    <ButtonLink
      href={LOGIN_ADDRESS}
      onClick={follow(LOGIN_ADDRESS)}
      iconEnd="arrow-right"
    >
      {t("nav.signIn")}
    </ButtonLink>
  );
}

export interface SessionExpiredNoticeProps {
  readonly focus?: boolean;
}

/** A shared, actionable 401 state for every private screen (REQ-211). */
export function SessionExpiredNotice({
  focus = false,
}: SessionExpiredNoticeProps = {}): ReactElement {
  const { t } = useLocale();

  return (
    <Notice nature="error" focus={focus} actions={<SignInLink />}>
      {t("nav.sessionExpired")}
    </Notice>
  );
}
