// A path inside the dashboard that leads nowhere, or to a page the person may not see.

import { IconArrowRight } from '@tabler/icons-react';
import { Link } from '@tanstack/react-router';

export const NOT_FOUND = 'Nothing here, or you may not see it.';

export function NotFound() {
  return (
    <div className="list-page">
      <header className="page__head rise">
        <h1 className="page__title">{NOT_FOUND}</h1>
      </header>
      <p className="rise">
        <Link to="/" className="more">
          Home
          <IconArrowRight size={14} stroke={1.75} aria-hidden="true" />
        </Link>
      </p>
    </div>
  );
}
