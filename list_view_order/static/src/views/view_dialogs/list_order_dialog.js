/** @odoo-module **/

import {_t} from "@web/core/l10n/translation";
import {browser} from "@web/core/browser/browser";
import {CheckBox} from "@web/core/checkbox/checkbox";
import {Dialog} from "@web/core/dialog/dialog";
import {Popover} from "@web/core/popover/popover";
import {unique} from "@web/core/utils/arrays";
import {useService} from "@web/core/utils/hooks";
import {fuzzyLookup} from "@web/core/utils/search";
import {useSortable} from "@web/core/utils/sortable_owl";
import {useDebounced} from "@web/core/utils/timing";

import {
    Component,
    useRef,
    useState,
    onMounted,
    onWillStart,
    onWillUnmount,
} from "@odoo/owl";

const FIELD_VISIBILITY = {
    ALWAYS: "always",
    OPTIONAL_SHOW: "optional_show",
    OPTIONAL_HIDE: "optional_hide",
};

class ListOrderItem extends Component {
    onDoubleClick(id) {
        if (!this.isFieldSelected(id)) {
            this.props.onAdd(id);
        }
    }

    isFieldSelected(current) {
        return this.props.orderList?.find(({id}) => id === current);
    }
}
ListOrderItem.template = "list_view_order.ListOrderItem";
ListOrderItem.components = {ListOrderItem};
ListOrderItem.props = {
    orderList: {type: Object, optional: true},
    field: {type: Object, optional: true},
    isDebug: Boolean,
    onAdd: Function,
    loadFields: Function,
};

const listOrderCache = new Map();

const getCacheKey = (resModel, viewId, userId) => `${resModel}-${viewId}-${userId}`;

export class ListOrderDialog extends Component {
    setup() {
        this.dialog = useService("dialog");
        this.notification = useService("notification");
        this.orm = useService("orm");
        this.rpc = useService("rpc");
        this.userService = useService("user");
        this.draggableRef = useRef("draggable");
        this.orderListRef = useRef("orderList");
        this.searchRef = useRef("search");

        this.knownFields = {};
        this.expandedFields = {};

        this.state = useState({
            orderList: [],
            isCompatible: false,
            search: [],
            isSmall: this.env.isSmall,
            disabled: false,
            fieldProperties: {},
            activePopover: null,
            tempFieldSettings: {},
        });

        this.title = _t("Rearrange List");
        this.removeFieldText = _t("Remove field");
        this.visibilityOptions = [
            {id: FIELD_VISIBILITY.ALWAYS, label: "Always Show"},
            {id: FIELD_VISIBILITY.OPTIONAL_SHOW, label: "Optional (Show)"},
            {id: FIELD_VISIBILITY.OPTIONAL_HIDE, label: "Optional (Hide)"},
        ];

        this._setupSortable();
        this._setupLifecycle();
    }

    _setupSortable() {
        useSortable({
            ref: this.draggableRef,
            elements: ".o_export_field",
            handle: ".o_drag_handle",
            enable: !this.state.isSmall,
            cursor: "grabbing",
            onDrop: this._handleDrop.bind(this),
            // Prevent drag on certain elements
            filter: ".form-control, .btn, .list-group-item",
        });
    }

    _setupLifecycle() {
        this.debouncedOnResize = useDebounced(this.updateSize, 300);

        onWillStart(async () => {
            await this.fetchFields();
        });

        onMounted(() => {
            browser.addEventListener("resize", this.debouncedOnResize);
            this.updateSize();
        });

        onWillUnmount(() => {
            browser.removeEventListener("resize", this.debouncedOnResize);
            // Don't clear cache on unmount to preserve state between openings
        });
    }

    _handleDrop({element, previous, next}) {
        const elementId = element.dataset.field_id;
        const previousId = previous?.dataset.field_id;
        const nextId = next?.dataset.field_id;

        const currentIndex = this.state.orderList.findIndex((f) => f.id === elementId);
        if (currentIndex === -1) return;

        let targetIndex;
        if (previousId) {
            const previousIndex = this.state.orderList.findIndex(
                (f) => f.id === previousId
            );
            targetIndex = previousIndex + 1;
        } else if (nextId) {
            targetIndex = this.state.orderList.findIndex((f) => f.id === nextId);
        } else {
            targetIndex = this.state.orderList.length;
        }

        // Adjust target index if moving the element downwards
        if (currentIndex < targetIndex) {
            targetIndex--;
        }

        if (currentIndex !== targetIndex) {
            this.onDraggingEnd(currentIndex, targetIndex);
        }
    }

    get fieldsAvailable() {
        const searchValue = this.searchRef.el?.value;
        if (searchValue) {
            return this.state.search.length ? Object.values(this.state.search) : [];
        }
        return Object.values(this.knownFields);
    }

    get isDebug() {
        return Boolean(odoo.debug);
    }

    get rootFields() {
        if (this.searchRef.el && this.searchRef.el.value) {
            const rootFromSearchResults = this.fieldsAvailable.map((f) => {
                if (f.parent) {
                    const parentEl = this.knownFields[f.parent.id];
                    return this.knownFields[
                        parentEl.parent ? parentEl.parent.id : parentEl.id
                    ];
                }
                return this.knownFields[f.id];
            });
            return unique(rootFromSearchResults);
        }
        return this.fieldsAvailable.filter(({parent}) => !parent);
    }

    updateSize() {
        this.state.isSmall = this.env.isSmall;
    }

    /**
     * Load fields to display and (re)set the list of available fields
     */
    async fetchFields() {
        this.state.search = [];
        this.knownFields = {};
        this.expandedFields = {};
        await this.loadFields();
        if (this.searchRef.el) {
            this.searchRef.el.value = "";
        }
        this.loadOrderList();
    }

    async loadOrderList() {
        const cacheKey = getCacheKey(
            this.props.root.resModel,
            this.props.viewId,
            this.userService.context.uid
        );
        if (listOrderCache.has(cacheKey)) {
            const cachedData = listOrderCache.get(cacheKey);
            this._updateStateFromFields(cachedData);
            return;
        }

        const fieldsData = await this.rpc("/web/list/get_current_list", {
            user_id: this.userService.context.uid,
            model: this.props.root.resModel,
            view_id: this.props.viewId,
        });

        listOrderCache.set(cacheKey, fieldsData);
        this._updateStateFromFields(fieldsData);
    }

    _updateStateFromFields(fields) {
        this.state.fieldProperties = {};
        const newOrderList = [];

        fields.forEach(({name, visibility, string, widget, decorations, label}) => {
            this.state.fieldProperties[name] = {
                visibility: this._mapServerVisibilityToClient(visibility),
                string: string || label || this.knownFields[name]?.string || name,
                widget: widget || "",
                decorations: decorations || "",
            };

            newOrderList.push({
                id: name,
                name: name,
                string: this.state.fieldProperties[name].string,
            });
        });

        this.state.orderList.forEach((field) => {
            if (!(field.id in this.state.fieldProperties)) {
                this._ensureFieldProperties(field.id);
            }
        });

        this.state.orderList = newOrderList;
    }

    _mapServerVisibilityToClient(serverVisibility) {
        switch (serverVisibility) {
            case "hide":
                return FIELD_VISIBILITY.OPTIONAL_HIDE;
            case "show":
                return FIELD_VISIBILITY.OPTIONAL_SHOW;
            case "always":
            default:
                return FIELD_VISIBILITY.ALWAYS;
        }
    }

    _mapClientVisibilityToServer(clientVisibility) {
        switch (clientVisibility) {
            case FIELD_VISIBILITY.OPTIONAL_HIDE:
                return "optional_hide";
            case FIELD_VISIBILITY.OPTIONAL_SHOW:
                return "optional_show";
            case FIELD_VISIBILITY.ALWAYS:
            default:
                return "always";
        }
    }

    async loadFields(id, preventLoad = false) {
        let model = this.props.root.resModel;
        let parentField, parentParams;
        if (id) {
            if (this.expandedFields[id]) {
                return this.expandedFields[id].fields;
            }
            parentField = this.knownFields[id];
            model = parentField.params && parentField.params.model;
            parentParams = {
                ...parentField.params,
                parent_field_type: parentField.field_type,
                parent_field: parentField,
                parent_name: parentField.string,
                exclude: [parentField.relation_field],
            };
        }
        if (preventLoad) {
            return;
        }
        const fields = await this.props.getListFields(
            model,
            this.state.isCompatible,
            parentParams
        );
        for (const field of fields) {
            field.parent = parentField;
            if (!this.knownFields[field.id]) {
                this.knownFields[field.id] = field;
            }
        }
        if (id) {
            this.expandedFields[id] = {fields};
        }
        return fields;
    }

    onDraggingEnd(item, target) {
        this.state.orderList.splice(target, 0, this.state.orderList.splice(item, 1)[0]);
    }

    onAddItemExportList(fieldId) {
        if (!this.state.orderList.some((f) => f.id === fieldId)) {
            const field = this.knownFields[fieldId];
            if (field) {
                this._ensureFieldProperties(fieldId);
                this.state.orderList.push(field);
            }
        }
    }

    onRemoveItemExportList(fieldId) {
        const index = this.state.orderList.findIndex(({id}) => id === fieldId);
        if (index !== -1) {
            this.state.orderList.splice(index, 1);
        }
    }

    setFieldVisibility(fieldId, visibility) {
        this._ensureFieldProperties(fieldId);
        if (!this.state.tempFieldSettings[fieldId]) {
            this.state.tempFieldSettings[fieldId] = {};
        }
        this.state.tempFieldSettings[fieldId].visibility = visibility;
    }

    getFieldVisibility(fieldId) {
        if (this.state.tempFieldSettings[fieldId]?.visibility !== undefined) {
            return this.state.tempFieldSettings[fieldId].visibility;
        }
        this._ensureFieldProperties(fieldId);
        return (
            this.state.fieldProperties[fieldId]?.visibility || FIELD_VISIBILITY.ALWAYS
        );
    }

    getFieldString(fieldId) {
        if (this.state.tempFieldSettings[fieldId]?.string !== undefined) {
            return this.state.tempFieldSettings[fieldId].string;
        }
        this._ensureFieldProperties(fieldId);
        return (
            this.state.fieldProperties[fieldId]?.string ||
            this.knownFields[fieldId]?.string ||
            ""
        );
    }

    getFieldWidget(fieldId) {
        if (this.state.tempFieldSettings[fieldId]?.widget !== undefined) {
            return this.state.tempFieldSettings[fieldId].widget;
        }
        this._ensureFieldProperties(fieldId);
        return this.state.fieldProperties[fieldId]?.widget || "";
    }

    getFieldDecorations(fieldId) {
        if (this.state.tempFieldSettings[fieldId]?.decorations !== undefined) {
            return this.state.tempFieldSettings[fieldId].decorations;
        }
        this._ensureFieldProperties(fieldId);
        return this.state.fieldProperties[fieldId]?.decorations || "";
    }

    setTempFieldString(fieldId, value) {
        this._ensureFieldProperties(fieldId);
        if (!this.state.tempFieldSettings[fieldId]) {
            this.state.tempFieldSettings[fieldId] = {};
        }
        this.state.tempFieldSettings[fieldId].string = value;
    }

    setTempFieldWidget(fieldId, value) {
        this._ensureFieldProperties(fieldId);
        if (!this.state.tempFieldSettings[fieldId]) {
            this.state.tempFieldSettings[fieldId] = {};
        }
        this.state.tempFieldSettings[fieldId].widget = value;
    }

    setTempFieldDecorations(fieldId, value) {
        this._ensureFieldProperties(fieldId);
        if (!this.state.tempFieldSettings[fieldId]) {
            this.state.tempFieldSettings[fieldId] = {};
        }
        this.state.tempFieldSettings[fieldId].decorations = value;
    }

    _ensureFieldProperties(fieldId) {
        if (!this.state.fieldProperties[fieldId]) {
            const fieldInfo = this.knownFields[fieldId];
            this.state.fieldProperties[fieldId] = {
                visibility: FIELD_VISIBILITY.ALWAYS,
                string: fieldInfo?.string || fieldId,
                widget: "",
                decorations: "",
            };
        }
    }

    async onClickOrderList() {
        if (!this.state.orderList.length) {
            return this.notification.add(
                _t("Please select fields to save order list..."),
                {
                    type: "danger",
                }
            );
        }
        this.state.disabled = true;

        const fieldsWithProperties = this.state.orderList.map((field) => ({
            id: field.id,
            name: field.name,
            label: this.getFieldString(field.id),
            visibility: this._mapClientVisibilityToServer(
                this.getFieldVisibility(field.id)
            ),
            string: this.getFieldString(field.id),
            widget: this.getFieldWidget(field.id),
            decorations: this.getFieldDecorations(field.id),
        }));

        await this.orm.call(
            "list.order",
            "action_process_order_list",
            [
                this.userService.context.uid,
                this.props.root.resModel,
                fieldsWithProperties,
                this.props.viewId,
            ],
            {}
        );

        const cacheKey = getCacheKey(
            this.props.root.resModel,
            this.props.viewId,
            this.userService.context.uid
        );
        listOrderCache.delete(cacheKey);

        this.state.disabled = false;
        this.props.close();
        window.location.reload();
    }

    async onClickDeleteOrderList() {
        this.state.disabled = true;

        await this.orm.call(
            "list.order",
            "action_delete_order_list",
            [this.userService.context.uid, this.props.root.resModel, this.props.viewId],
            {}
        );

        const cacheKey = getCacheKey(
            this.props.root.resModel,
            this.props.viewId,
            this.userService.context.uid
        );
        listOrderCache.delete(cacheKey);

        this.state.disabled = false;
        this.props.close();
        window.location.reload();
    }

    onSearch(ev) {
        this.state.search = this.lookup(ev.target.value);
    }

    lookup(value) {
        if (!value) return [];

        const fieldsArray = Object.values(this.knownFields);
        const fuzzyResults = fuzzyLookup(value, fieldsArray, (field) =>
            field.string.split("/").reverse().join("/")
        );

        if (!this.isDebug) {
            return fuzzyResults;
        }

        return unique([
            ...fuzzyResults,
            ...fieldsArray.filter((f) => f.id.includes(value)),
        ]);
    }

    toggleFieldSettings(fieldId, targetElement) {
        if (this.state.activePopover?.fieldId === fieldId) {
            this.state.activePopover = null;
        } else {
            this.state.activePopover = {
                fieldId,
                target: targetElement,
            };
        }
    }
    closePopover() {
        this.state.activePopover = null;
    }
    saveFieldProperties(fieldId) {
        if (this.state.tempFieldSettings[fieldId]) {
            const temps = this.state.tempFieldSettings[fieldId];
            const props = this.state.fieldProperties[fieldId];

            if (temps.visibility !== undefined) props.visibility = temps.visibility;
            if (temps.string !== undefined) {
                props.string = temps.string;
                const orderListItem = this.state.orderList.find(
                    (f) => f.id === fieldId
                );
                if (orderListItem) orderListItem.string = props.string;
            }
            if (temps.widget !== undefined) props.widget = temps.widget;
            if (temps.decorations !== undefined) props.decorations = temps.decorations;

            delete this.state.tempFieldSettings[fieldId];
        }
        this.closePopover();
    }
}
ListOrderDialog.components = {CheckBox, Dialog, ListOrderItem, Popover};
ListOrderDialog.props = {
    close: {type: Function},
    context: {type: Object, optional: true},
    defaultExportList: {type: Array},
    getListFields: {type: Function},
    root: {type: Object},
    viewId: {type: Number},
};
ListOrderDialog.template = "list_view_order.ListOrderDialog";
