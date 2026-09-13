"""One-time local bootstrap: interactive Garmin login (email + password + MFA).
Prints the token blob to STDOUT (nothing else there) so it can be piped:

    npm run auth | gh secret set GARMIN_TOKEN

Also dumps tokens to ~/.garminconnect for local `npm run fetch:garmin` reuse.
Rerun only after a password change or token revocation."""
import getpass
import os
import sys

from garminconnect import Garmin


def _prompt(text):
    """Write prompt to stderr, read from stdin — never touches stdout."""
    sys.stderr.write(text)
    sys.stderr.flush()
    return input()


def main():
    email = os.environ.get("GARMIN_EMAIL") or _prompt("Garmin email: ").strip()
    password = os.environ.get("GARMIN_PASSWORD") or getpass.getpass("Garmin password: ")

    def mfa():
        return _prompt("MFA code: ").strip()

    g = Garmin(email=email, password=password, is_cn=False, prompt_mfa=mfa)
    print("logging in…", file=sys.stderr)
    g.login()

    tokdir = os.path.expanduser("~/.garminconnect")
    g.client.dump(tokdir)                      # local reuse via GARMINTOKENS
    print(f"tokens dumped to {tokdir}", file=sys.stderr)

    sys.stdout.write(g.client.dumps())         # the blob — STDOUT only
    sys.stdout.flush()


if __name__ == "__main__":
    main()
