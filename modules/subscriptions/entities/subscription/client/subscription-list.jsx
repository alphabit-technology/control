'use strict';

import React from 'react';
import ListContext from '@context/list-context';
import { Button } from '@cn/components/ui/button';
import { Plus } from 'lucide-react';
import CreateForExistingModal from './create-for-existing-modal';

/**
 * Subscription list view + toolbar button to create a Stripe Subscription
 * for an EXISTING tenant. Opens a modal with the three modes (trial /
 * scheduled / checkout). Backend: actionCreateForExisting in signup-controller.
 */
export default class SubscriptionList extends ListContext {
  constructor(props) {
    super(props);
    this.state = { ...(this.state || {}), modalOpen: false };
    this.openModal  = this.openModal.bind(this);
    this.closeModal = this.closeModal.bind(this);
  }

  openModal()  { this.setState({ modalOpen: true }); }
  closeModal() { this.setState({ modalOpen: false }); }

  setCustomActions() {
    this.setCustomAction('newForExistingTenant', (
      <Button
        key="newForExistingTenant"
        onClick={this.openModal}
        size="sm"
      >
        <Plus className="h-4 w-4 mr-1" />
        New for existing tenant
      </Button>
    ));
  }

  render(content, slots) {
    return (
      <>
        {super.render(content, slots)}
        <CreateForExistingModal
          open={!!this.state?.modalOpen}
          onClose={this.closeModal}
        />
      </>
    );
  }
}
