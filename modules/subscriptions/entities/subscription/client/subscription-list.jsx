'use strict';

import { useState } from 'react';
import { ListLayout } from '@loopar/list';
import { Button } from '@cn/components/ui/button';
import { Plus, Mail } from 'lucide-react';
import CreateForExistingModal from './create-for-existing-modal';
import ResendActivationModal from './resend-activation-modal';

/**
 * Subscription list — adds two operator actions to the toolbar:
 *   - "New for existing tenant" → create a Stripe Sub for a workspace that
 *     already exists (trial / scheduled / checkout). Backend:
 *     actionCreateForExisting in signup-controller.
 *   - "Resend activation email" → generate a fresh Customer Portal session
 *     and re-send the activation email for a Sub that's still waiting on a
 *     payment method. Backend: actionResendActivationEmail.
 */
export default function SubscriptionList() {
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [resendModalOpen, setResendModalOpen] = useState(false);

  const actions = {
    newForExistingTenant: (
      <Button key="newForExistingTenant" onClick={() => setCreateModalOpen(true)} size="sm">
        <Plus className="h-4 w-4 mr-1" />
        New for existing tenant
      </Button>
    ),
    resendActivation: (
      <Button key="resendActivation" onClick={() => setResendModalOpen(true)} size="sm" variant="outline">
        <Mail className="h-4 w-4 mr-1" />
        Resend activation email
      </Button>
    ),
  };

  return (
    <>
      <ListLayout actions={actions} />
      <CreateForExistingModal open={createModalOpen} onClose={() => setCreateModalOpen(false)} />
      <ResendActivationModal open={resendModalOpen} onClose={() => setResendModalOpen(false)} />
    </>
  );
}
