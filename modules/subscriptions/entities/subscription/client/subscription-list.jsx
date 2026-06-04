'use strict';

import React from 'react';
import ListContext from '@context/list-context';
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
export default class SubscriptionList extends ListContext {
  constructor(props) {
    super(props);
    this.state = {
      ...(this.state || {}),
      createModalOpen: false,
      resendModalOpen: false,
    };
    this.openCreateModal  = () => this.setState({ createModalOpen: true });
    this.closeCreateModal = () => this.setState({ createModalOpen: false });
    this.openResendModal  = () => this.setState({ resendModalOpen: true });
    this.closeResendModal = () => this.setState({ resendModalOpen: false });
  }

  setCustomActions() {
    this.setCustomAction('newForExistingTenant', (
      <Button
        key="newForExistingTenant"
        onClick={this.openCreateModal}
        size="sm"
      >
        <Plus className="h-4 w-4 mr-1" />
        New for existing tenant
      </Button>
    ));

    this.setCustomAction('resendActivation', (
      <Button
        key="resendActivation"
        onClick={this.openResendModal}
        size="sm"
        variant="outline"
      >
        <Mail className="h-4 w-4 mr-1" />
        Resend activation email
      </Button>
    ));
  }

  render(content, slots) {
    return (
      <>
        {super.render(content, slots)}
        <CreateForExistingModal
          open={!!this.state?.createModalOpen}
          onClose={this.closeCreateModal}
        />
        <ResendActivationModal
          open={!!this.state?.resendModalOpen}
          onClose={this.closeResendModal}
        />
      </>
    );
  }
}
