export type Status = 'incomplete' | 'started' | 'completed' | 'rejected' | 'note';

export interface TodoItem {
    status: Status;
    text: string;
    children: TodoItem[];
}

export interface Section {
    name: string;
    items: TodoItem[];
}

export interface AddItemAction {
    kind: 'addItem';
    targetDate: string;
    sectionName: string;
    item: TodoItem;
}

export type Action = AddItemAction;
