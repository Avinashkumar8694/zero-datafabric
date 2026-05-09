export type TriggerEventType = 
    'BEFORE_INSERT' | 'AFTER_INSERT' | 
    'BEFORE_UPDATE' | 'AFTER_UPDATE' | 
    'BEFORE_DELETE' | 'AFTER_DELETE' | 
    'INSTEAD_OF_INSERT' | 'INSTEAD_OF_UPDATE' | 'INSTEAD_OF_DELETE';

export type TriggerExecuteType = 'FUNCTION' | 'WEBHOOK' | 'EXCEPTION' | 'AUDIT';

export interface TriggerDefinition {
    name: string;
    event: TriggerEventType;
    condition?: any;
    execute: {
        type: TriggerExecuteType;
        name?: string;
        url?: string;
        method?: string;
        payload?: any;
        params?: any;
        message?: string;
        when?: any;
    };
    schedule?: {
        type: 'FIXED' | 'RELATIVE';
        cron?: string;
        column?: string;
        after?: number;
        unit?: 'MINUTE' | 'HOUR' | 'DAY' | 'MONTH';
        maxAttempts?: number;
    };
    autoDrop?: {
        when: any;
        message?: string;
    };
    scope?: 'ROW' | 'STATEMENT';
}
