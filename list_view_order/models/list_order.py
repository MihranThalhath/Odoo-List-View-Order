from odoo import api, fields, models


class ListOrder(models.Model):
    _name = "list.order"
    _description = "List Order"

    name = fields.Char(string="Name")
    user_id = fields.Many2one(
        comodel_name="res.users",
        string="User",
        required=True,
        index=True,
    )
    active = fields.Boolean(string="Active", default=True)
    sequence = fields.Integer(string="Sequence", default=10)
    ir_model_id = fields.Many2one(
        comodel_name="ir.model",
        string="Model",
        required=True,
        ondelete="cascade",
    )
    ir_model_name = fields.Char(
        string="Model Name",
        related="ir_model_id.model",
        store=True,
        index=True,
    )
    list_order_line_ids = fields.One2many(
        comodel_name="list.order.line",
        inverse_name="list_order_id",
        string="List Order Lines",
    )
    ir_ui_view_id = fields.Many2one(
        comodel_name="ir.ui.view",
        string="View",
        ondelete="cascade",
        index="btree_not_null",
    )

    @api.model
    def action_process_order_list(
        self, current_user_id, model_name, new_order_list, view_id
    ) -> bool:
        if not new_order_list:
            return False
        user = self.env["res.users"].browse(current_user_id)
        list_order = self.action_get_list_order_objects(user.id, model_name, view_id)

        if not list_order:
            ir_model = self.env["ir.model"].search(
                [("model", "=", model_name)], limit=1
            )
            if not ir_model:
                return False
            values = {
                "user_id": user.id,
                "ir_model_id": ir_model.id,
                "ir_ui_view_id": view_id or False,
            }
            list_order = self.env["list.order"].create(values)

        list_order.action_update_order_list(user, new_order_list)
        return True

    def action_update_order_list(self, user_id, new_order_list) -> bool:
        self.ensure_one()
        if not new_order_list:
            return False

        self.write({"list_order_line_ids": [(5, 0, 0)]})

        vals_list = []

        for sequence, field_data in enumerate(new_order_list, start=1):
            field_name = field_data.get("name") or field_data.get("id")
            if not field_name:
                continue

            ir_model_field = self.env["ir.model.fields"].search(
                [
                    ("model", "=", self.ir_model_name),
                    ("name", "=", field_name),
                ],
                limit=1,
            )
            if not ir_model_field:
                continue

            visibility = field_data.get("visibility")
            if visibility == "optional_hide":
                custom_field_visibility = "hide"
            elif visibility == "optional_show":
                custom_field_visibility = "show"
            else:
                custom_field_visibility = "always"

            vals = {
                "list_order_id": self.id,
                "sequence": sequence,
                "user_id": user_id.id,
                "ir_model_field_id": ir_model_field.id,
                "field_visibility": custom_field_visibility,
                "field_widget": field_data.get("widget", ""),
                "field_string": field_data.get("string") or field_data.get("label", ""),
                "field_decorations": field_data.get("decorations", ""),
            }
            vals_list.append(vals)

        if vals_list:
            self.env["list.order.line"].create(vals_list)
        return True

    @api.model
    def action_get_list_order_objects(self, user_id, model_name, view_id):
        domain = [
            ("user_id", "=", user_id),
            ("ir_model_name", "=", model_name),
            ("ir_ui_view_id", "=", view_id),
            ("active", "=", True),
        ]
        list_order = self.env["list.order"].search(
            domain, order="sequence asc", limit=1
        )
        return list_order

    @api.model
    def action_get_list_order(self, user_id, model_name, view_id):
        list_order = self.action_get_list_order_objects(user_id, model_name, view_id)
        if not list_order:
            return []

        result = [
            {
                "name": line.ir_model_field_name,
                "optional": (
                    line.field_visibility
                    if line.field_visibility != "always"
                    else False
                ),
                "widget": line.field_widget or "",
                "string": line.field_string or "",
                "decorations": line.field_decorations or "",
            }
            for line in list_order.list_order_line_ids
        ]

        return result

    @api.model
    def action_delete_order_list(self, user_id, model_name, view_id) -> bool:
        list_order_to_delete = self.action_get_list_order_objects(
            user_id, model_name, view_id
        )
        if list_order_to_delete:
            list_order_to_delete.unlink()
            return True
        return False


class ListOrderLine(models.Model):
    _name = "list.order.line"
    _description = "List Order Line"

    list_order_id = fields.Many2one(
        comodel_name="list.order",
        string="List Order",
        required=True,
        ondelete="cascade",
    )
    sequence = fields.Integer(string="Sequence", default=10)
    user_id = fields.Many2one(
        comodel_name="res.users",
        string="User",
        required=True,
        index=True,
    )
    ir_model_field_id = fields.Many2one(
        comodel_name="ir.model.fields",
        string="Field",
        required=True,
        ondelete="cascade",
    )
    ir_model_field_name = fields.Char(
        string="Field Name",
        related="ir_model_field_id.name",
        store=True,
    )
    field_visibility = fields.Selection(
        selection=[
            ("always", "Always"),
            ("hide", "Optional Hide"),
            ("show", "Optional Show"),
        ],
        string="Field Visibility",
        required=True,
        default="always",
    )
    field_string = fields.Char(string="String")
    field_widget = fields.Char(string="Widget")
    field_decorations = fields.Char(string="Decorations")
