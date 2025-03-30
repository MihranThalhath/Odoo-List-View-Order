/** @odoo-module */

import {browser} from "@web/core/browser/browser";
import {isMobileOS} from "@web/core/browser/feature_detection";
import {useService} from "@web/core/utils/hooks";
import {patch} from "@web/core/utils/patch";
import {registry} from "@web/core/registry";
import {ListRenderer} from "@web/views/list/list_renderer";
import {ListOrderDialog} from "@list_view_order/views/view_dialogs/list_order_dialog";
import {_t} from "@web/core/l10n/translation";
import {onWillDestroy, onWillStart, onWillUpdateProps, useState} from "@odoo/owl";
import {unique} from "@web/core/utils/arrays";
import {evaluateBooleanExpr} from "@web/core/py_js/py";
import {session} from "@web/session";

export const patchListViewRendererController = () => ({
    setup() {
        super.setup();
        this.orm = useService("orm");
        this.rpc = useService("rpc");
        this.userService = useService("user");
        this.actionService = useService("action");
        this.dialogService = useService("dialog");
        this.originalNonInvisibleColumns = this.allColumns.filter(
            (col) => !this.evalColumnInvisible(col.column_invisible)
        );
        const list = this.props.list;
        const {actionId, actionType} = this.env.config || {};

        const isListViewPotentiallyEditable =
            !isMobileOS() &&
            !this.env.inDialog &&
            session.modify_list_view &&
            list === list.model.root &&
            actionId &&
            actionType === "ir.actions.act_window";
        this.listViewEditable = useState({value: isListViewPotentiallyEditable});
        if (
            !this.isX2Many &&
            session.modify_list_view &&
            isListViewPotentiallyEditable
        ) {
            this.state = useState({
                columns: [],
                allModelColumns: [],
                isCustomOrder: false,
                orderedOptionalColumns: [],
            });
        }
        if (isListViewPotentiallyEditable) {
            const computeOrderListEditable = (action) => {
                if (!action.xml_id) {
                    return false;
                }
                if (
                    action.res_model.indexOf("settings") > -1 &&
                    action.res_model.indexOf("x_") !== 0
                ) {
                    return false;
                }
                if (action.res_model === "board.board") {
                    return false;
                }
                if (action.view_mode === "qweb") {
                    return false;
                }
                if (action.res_model === "knowledge.article") {
                    return false;
                }
                return Boolean(action.res_model);
            };
            const onUiUpdated = () => {
                const action = this.actionService.currentController.action;
                if (action.id === actionId) {
                    this.listViewEditable.value = computeOrderListEditable(action);
                }
                stopListening();
            };
            const stopListening = () =>
                this.env.bus.removeEventListener(
                    "ACTION_MANAGER:UI-UPDATED",
                    onUiUpdated
                );
            this.env.bus.addEventListener("ACTION_MANAGER:UI-UPDATED", onUiUpdated);

            onWillStart(async () => {
                if (!this.isX2Many && session.modify_list_view) {
                    await this.initializeColumns(this.props);
                }
            });

            onWillUpdateProps(async (nextProps) => {
                if (!this.isX2Many && session.modify_list_view) {
                    await this.initializeColumns(nextProps);
                }
            });

            onWillDestroy(stopListening);
        }
    },

    async initializeColumns(props) {
        this.state.allModelColumns = await this.processModelFields(props.list);

        let archColumns = [];
        if (props.archInfo?.columns) {
            archColumns = this.processAllColumn(props.archInfo.columns, props.list);
        }
        this.allColumns = archColumns;

        const result = await this.getCustomActiveColumns(props.list);
        this.state.isCustomOrder = result.isCustomOrder;
        this.keyOptionalFields = result.customKeyOptionalFields;

        let columnsToDisplay = [];
        let allCustomColumns = [];

        if (this.state.isCustomOrder) {
            allCustomColumns = result.columnsFromOrder;
            this.orderedOptionalColumns = result.orderedOptionalColumns;

            this.optionalActiveFields = {};
            const storedFields = this.keyOptionalFields
                ? browser.localStorage.getItem(this.keyOptionalFields)
                : null;
            const storedFieldsArray = storedFields ? storedFields.split(",") : [];

            allCustomColumns.forEach((col) => {
                if (col.optional) {
                    if (storedFields !== null) {
                        this.optionalActiveFields[col.name] =
                            storedFieldsArray.includes(col.name);
                    } else {
                        this.optionalActiveFields[col.name] = col.optional === "show";
                    }
                }
            });

            if (storedFields !== null) {
                storedFieldsArray.forEach((fieldName) => {
                    const col = allCustomColumns.find((c) => c.name === fieldName);
                    if (col && col.optional && !this.optionalActiveFields[fieldName]) {
                        this.optionalActiveFields[fieldName] = true;
                    }
                });
            }

            columnsToDisplay = allCustomColumns.filter((col) => {
                if (props.list.isGrouped && col.widget === "handle") return false;
                if (this.evalColumnInvisible(col.column_invisible)) return false;
                if (col.optional) return this.optionalActiveFields[col.name];
                return true;
            });

            this.allColumns = allCustomColumns;
        } else {
            this.optionalActiveFields = {};

            archColumns.forEach((col) => {
                if (col.optional) {
                    this.optionalActiveFields[col.name] = col.optional === "show";
                }
            });

            columnsToDisplay = archColumns.filter((col) => {
                if (props.list.isGrouped && col.widget === "handle") return false;
                if (this.evalColumnInvisible(col.column_invisible)) return false;
                if (col.optional) return this.optionalActiveFields[col.name];
                return true;
            });

            this.allColumns = archColumns;
        }

        this.state.columns = columnsToDisplay;
    },

    async processModelFields(list) {
        const fields = await this.rpc("/web/list/get_list_fields", {
            model: list.resModel,
        });

        return Object.entries(fields).map(([fieldName, field]) => ({
            type: "field",
            name: field.id,
            label: field.string || fieldName,
            widget: field.widget,
            optional: false,
            sortable: true,
            attrs: {},
            hasLabel: true,
            id: `field_${fieldName}`,
            decorations: {},
            options: {},
        }));
    },

    async getListFields(model, import_compat, parentParams) {
        if (!session.order_fields_list) {
            return this.originalNonInvisibleColumns;
        }
        return await this.rpc("/web/list/get_list_fields", {
            ...parentParams,
            model,
            import_compat,
        });
    },
    async getCustomActiveColumns(list) {
        const orderList = await this.orm.call(
            "list.order",
            "action_get_list_order",
            [
                this.userService.context.uid,
                this.props.list.resModel,
                this.env.config.viewId,
            ],
            {}
        );

        if (orderList.length === 0) {
            return {
                columns: this.allColumns.filter((col) => {
                    if (list.isGrouped && col.widget === "handle") {
                        return false;
                    }
                    if (col.optional && !this.optionalActiveFields[col.name]) {
                        return false;
                    }
                    if (this.evalColumnInvisible(col.column_invisible)) {
                        return false;
                    }
                    return true;
                }),
                isCustomOrder: false,
                customKeyOptionalFields: false,
            };
        }

        let processedOrderList = orderList;
        if (this.state.isCustomOrder) {
            processedOrderList = orderList.map((order) => ({
                ...order,
                optional:
                    order.name in this.optionalActiveFields
                        ? this.optionalActiveFields[order.name]
                            ? "show"
                            : "hide"
                        : order.optional,
                widget: order.widget,
                label: order.string,
                decorations: order.decorations,
            }));
        }

        const allColumns = this.state.allModelColumns.filter((col) => {
            if (list.isGrouped && col.widget === "handle") {
                return false;
            }
            return processedOrderList.some((order) => order.name === col.name);
        });

        const mapOrderToColumn = (order) => {
            const column = allColumns.find((col) => col.name === order.name);
            if (!column) {
                return null;
            }

            const fieldsRegistry = registry.category("fields");
            let fieldComponent = order.widget && fieldsRegistry.get(order.widget);

            let decorations = {};
            if (order.decorations) {
                const decorationPairs =
                    order.decorations.match(/decoration-\w+="[^"]+"/g) || [];
                decorationPairs.forEach((pair) => {
                    const [key, ...valueParts] = pair.split("=");
                    const value = valueParts.join("=");
                    const cleanKey = key.replace("decoration-", "");
                    decorations[cleanKey] = value.replace(/"/g, "");
                });
            }

            return {
                ...column,
                optional: order.optional,
                widget: order.widget,
                field: fieldComponent,
                label: order.string || column.label,
                decorations: decorations,
            };
        };

        const columnsFromOrder = processedOrderList
            .map(mapOrderToColumn)
            .filter(Boolean);

        const orderedColumns = columnsFromOrder.filter((col) => {
            if (list.isGrouped && col.widget === "handle") return false;
            if (this.evalColumnInvisible(col.column_invisible)) return false;
            return true;
        });

        const orderedOptionalColumns = columnsFromOrder.filter(
            (col) => col.optional && !this.evalColumnInvisible(col.column_invisible)
        );

        const customKeyOptionalFields =
            `optional_fields_${this.userService.context.uid}_${this.props.list.resModel}_${this.env.config.viewId}_` +
            orderedOptionalColumns
                .map((col) => col.name)
                .sort()
                .join(",");

        return {
            columnsFromOrder: columnsFromOrder,
            isCustomOrder: true,
            customKeyOptionalFields,
            orderedOptionalColumns,
        };
    },

    get optionalFieldGroups() {
        if (this.isX2Many || !session.modify_list_view) {
            return super.optionalFieldGroups;
        }

        const propertyGroups = {};
        const optionalFields = [];
        let optionalColumns = [];

        if (this.state.isCustomOrder) {
            optionalColumns =
                this.orderedOptionalColumns?.filter(
                    (col) =>
                        col.optional && !this.evalColumnInvisible(col.column_invisible)
                ) || [];
        } else {
            optionalColumns =
                this.allColumns?.filter(
                    (col) =>
                        col.optional && !this.evalColumnInvisible(col.column_invisible)
                ) || [];
        }

        for (const col of optionalColumns) {
            const optionalField = {
                label: col.label,
                name: col.name,
                value: this.optionalActiveFields[col.name],
            };
            if (!col.relatedPropertyField) {
                optionalFields.push(optionalField);
            } else {
                const {displayName, id} = col.relatedPropertyField;
                if (propertyGroups[id]) {
                    propertyGroups[id].optionalFields.push(optionalField);
                } else {
                    propertyGroups[id] = {
                        id,
                        displayName,
                        optionalFields: [optionalField],
                    };
                }
            }
        }

        let calculatedGroups;
        if (optionalFields.length) {
            calculatedGroups = [{optionalFields}, ...Object.values(propertyGroups)];
        } else {
            calculatedGroups = Object.values(propertyGroups);
        }

        return calculatedGroups;
    },

    async toggleOptionalField(fieldName) {
        if (this.isX2Many || !session.modify_list_view) {
            await super.toggleOptionalField(fieldName);
            return;
        }

        this.optionalActiveFields[fieldName] = !this.optionalActiveFields[fieldName];

        if (this.props.onOptionalFieldsChanged) {
            this.props.onOptionalFieldsChanged(this.optionalActiveFields);
        }

        this.state.columns = this.allColumns.filter((col) => {
            if (this.props.list.isGrouped && col.widget === "handle") return false;
            if (this.evalColumnInvisible(col.column_invisible)) return false;
            if (col.optional) return this.optionalActiveFields[col.name];
            return true;
        });

        this.saveOptionalActiveFields();
    },

    async toggleOptionalFieldGroup(groupId) {
        if (this.isX2Many || !session.modify_list_view) {
            await super.toggleOptionalFieldGroup(groupId);
            return;
        }
        const fieldNames = this.allColumns
            .filter(
                (col) =>
                    col.type === "field" &&
                    col.relatedPropertyField &&
                    col.relatedPropertyField.id === groupId &&
                    !this.evalColumnInvisible(col.column_invisible)
            )
            .map((col) => col.name);

        const active = !fieldNames.every(
            (fieldName) => this.optionalActiveFields[fieldName]
        );
        for (const fieldName of fieldNames) {
            this.optionalActiveFields[fieldName] = active;
        }

        if (this.props.onOptionalFieldsChanged) {
            this.props.onOptionalFieldsChanged(this.optionalActiveFields);
        }

        this.state.columns = this.allColumns.filter((col) => {
            if (this.props.list.isGrouped && col.widget === "handle") return false;
            if (this.evalColumnInvisible(col.column_invisible)) return false;
            if (col.optional) return this.optionalActiveFields[col.name];
            return true;
        });

        this.saveOptionalActiveFields();
    },

    isListViewEditable() {
        return this.listViewEditable.value;
    },

    get defaultListViewFields() {
        return unique(
            this.props.archInfo.columns
                .filter((col) => col.type === "field")
                .filter((col) => !col.optional || this.optionalActiveFields[col.name])
                .filter(
                    (col) =>
                        !evaluateBooleanExpr(col.column_invisible, this.props.context)
                )
                .map((col) => this.props.list.fields[col.name])
                .filter((field) => field.exportable !== false)
        );
    },

    get hasOptionalFields() {
        return this.allColumns.some(
            (col) => col.optional && !this.evalColumnInvisible(col.column_invisible)
        );
    },

    onSelectedRearrangeListView() {
        const dialogProps = {
            context: this.props.context,
            defaultExportList: this.defaultListViewFields,
            getListFields: this.getListFields.bind(this),
            root: this.props.list.model.root,
            viewId: this.env.config.viewId,
        };
        this.dialogService.add(ListOrderDialog, dialogProps);
    },

    evalColumnInvisible(columnInvisible) {
        if (this.isX2Many || !session.modify_list_view) {
            return super.evalColumnInvisible(columnInvisible);
        }
        if (!columnInvisible) {
            return false;
        }
        try {
            return evaluateBooleanExpr(columnInvisible, this.props.context || {});
        } catch (e) {
            console.warn("Failed to evaluate column_invisible", e);
            return false;
        }
    },

    saveOptionalActiveFields() {
        try {
            if (super.saveOptionalActiveFields) {
                super.saveOptionalActiveFields(
                    this.state.columns.filter((col) => col.optional)
                );
            }
        } catch (e) {
            console.error("Error calling super.saveOptionalActiveFields:", e);
        }

        if (this.isX2Many || !session.modify_list_view || !this.keyOptionalFields) {
            return;
        }

        const activeOptionalFieldNames = Object.entries(this.optionalActiveFields)
            .filter(
                ([name, isActive]) =>
                    isActive &&
                    this.allColumns.some((col) => col.name === name && col.optional)
            )
            .map(([name, isActive]) => name)
            .join(",");

        browser.localStorage.setItem(this.keyOptionalFields, activeOptionalFieldNames);
    },

    processAllColumn(columns, list) {
        if (this.isX2Many || !session.modify_list_view) {
            return super.processAllColumn(columns, list);
        }
        if (!columns) {
            return [];
        }
        return columns.map((col) => ({
            ...col,
            sortable: col.type === "field" && list.fields[col.name]?.sortable !== false,
        }));
    },
});

export const unpatchListViewRendererController = patch(
    ListRenderer.prototype,
    patchListViewRendererController()
);
