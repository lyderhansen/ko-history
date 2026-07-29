import React from 'react';
import layout from '@splunk/react-page';
import WrapperApp from '../../components/WrapperApp';

layout(<WrapperApp />, {
    pageTitle: 'KO History: Wrapper',
    hideFooter: true,
    layout: 'fixed',
});
