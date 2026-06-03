'use strict';

import PageContext from '@context/page-context';
import { Button } from '@cn/components/ui/button';
import { XCircle, ArrowLeft } from 'lucide-react';
import { Link } from '@link';

function CloudCancelUI() {
  return (
    <div className="mx-auto max-w-md p-6">
      <div className="rounded-lg border border-border bg-card p-6 shadow-sm text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-muted mb-4">
          <XCircle className="h-6 w-6 text-muted-foreground" />
        </div>
        <h1 className="text-xl font-semibold mb-2">Checkout cancelled</h1>
        <p className="text-sm text-muted-foreground mb-5">
          No charge was made. Your workspace name is still available —
          come back whenever you're ready.
        </p>
        <Button asChild>
          <Link to="/Pricing" bare>
            <ArrowLeft className="h-4 w-4 mr-2" /> Back to pricing
          </Link>
        </Button>
      </div>
    </div>
  );
}

export default class CloudCancelPage extends PageContext {
  render() {
    return <CloudCancelUI />;
  }
}