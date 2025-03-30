from odoo import models


class IrHttp(models.AbstractModel):
    _inherit = "ir.http"

    def session_info(self):
        result = super().session_info()
        user = self.env.user
        ICP = self.env["ir.config_parameter"].sudo()

        order_fields_list = (
            ICP.get_param("list.view.controller.order.all.fields", "False").lower()
            == "true"
        )

        can_modify = user.has_group("list_view_order.group_modify_list_view")
        can_modify_all = user.has_group(
            "list_view_order.group_modify_list_view_all_fields"
        )

        result["order_fields_list"] = order_fields_list or can_modify_all
        result["modify_list_view"] = can_modify or can_modify_all

        return result
