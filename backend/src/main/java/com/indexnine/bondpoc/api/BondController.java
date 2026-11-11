package com.indexnine.bondpoc.api;

import com.indexnine.bondpoc.dto.MintRequest;
import com.indexnine.bondpoc.dto.OperationResult;
import com.indexnine.bondpoc.service.BondService;
import com.indexnine.bondpoc.service.OperationGuard;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/bonds")
@Tag(name = "2. Bonds", description = "Step 9: mint the bonds to the B&D wallet")
public class BondController {
    private final BondService bonds;
    private final OperationGuard guard;

    public BondController(BondService bonds, OperationGuard guard) {
        this.bonds = bonds;
        this.guard = guard;
    }

    @PostMapping("/mint")
    @Operation(summary = "Mint bonds to the B&D wallet, unpause the token and approve the DVD manager",
            description = "Uses the deal from the latest deployment. An empty body mints the full supply limit.")
    public OperationResult mint(@Valid @RequestBody(required = false) MintRequest request) {
        guard.acquire();
        try {
            return bonds.mintToBnd(request);
        } finally {
            guard.release();
        }
    }
}
