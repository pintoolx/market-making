// A plain link in the isolated component harness; production route tests use Next's real Link.
import type { AnchorHTMLAttributes } from 'react';
export default function TestLink(props: AnchorHTMLAttributes<HTMLAnchorElement>) { return <a {...props} />; }
