package com.indexnine.bondpoc.api;

import com.indexnine.bondpoc.dto.OperationResult;
import com.indexnine.bondpoc.dto.SettlementRequest;
import com.indexnine.bondpoc.service.OperationGuard;
import com.indexnine.bondpoc.service.SettlementService;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/settlements")
@Tag(name = "3. Settlement", description = "Steps 10-12: atomic delivery-versus-payment of bonds for cash")
public class SettlementController {
    private final SettlementService settlements;
    private final OperationGuard guard;

    public SettlementController(SettlementService settlements, OperationGuard guard) {
        this.settlements = settlements;
        this.guard = guard;
    }

    @PostMapping
    @Operation(summary = "Settle bonds against EURd with one whitelisted investor",
            description = "The investor approves the cash, B&D initiates the DVD transfer and the investor takes it, in one atomic swap.")
    public OperationResult settle(@Valid @RequestBody SettlementRequest request) {
        guard.acquire();
        try {
            return settlements.settle(request);
        } finally {
            guard.release();
        }
    }
}
